import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../platform';
import { clearMockData } from '../../test/platform-mocks';
import { initializeTestSchema } from '../../test/initializeTestSchema';

const dbMocks = vi.hoisted(() => ({
  requestStarted: vi.fn(),
  finishRegistration: vi.fn(() => Promise.resolve()),
}));

beforeEach(async () => {
  clearMockData();
  await initializeTestSchema();
  vi.spyOn(platform().db, 'ensureWorkspaceOwner').mockImplementation(
    async (root, access, discovery) => {
      dbMocks.requestStarted(root, access, discovery);
      await dbMocks.finishRegistration();
      return 1;
    }
  );
});

afterEach(() => vi.restoreAllMocks());

import type { WorkspaceInstance } from './types';
import {
  openWorkspaceFromSource,
  projectWorkspaceFolders,
  resolveWorkspaceAssetPath,
  selectDefaultWorkspacePath,
  validateWorkspaceRelativePath,
} from './open-workspace-from-source';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

const sampleInstance: WorkspaceInstance = {
  id: 'sample:standard-samples:v1',
  displayName: 'DNAForge Samples',
  rootFolders: [
    {
      path: '/Users/me/AppData/Sample Workspaces/standard-samples/v1/workspace',
      name: 'DNAForge Samples',
    },
  ],
  source: { kind: 'sample-template', templateId: 'standard-samples', mode: 'reuse' },
  writable: true,
  createdAt: 1,
};

describe('workspace asset path safety', () => {
  it('accepts workspace-relative asset paths', () => {
    expect(validateWorkspaceRelativePath('sequences/circular/pUC19.gb')).toBe(
      'sequences/circular/pUC19.gb'
    );
    expect(resolveWorkspaceAssetPath('/workspace', 'sequences/circular/pUC19.gb')).toBe(
      '/workspace/sequences/circular/pUC19.gb'
    );
  });

  it('rejects traversal and absolute asset paths', () => {
    expect(() => validateWorkspaceRelativePath('../pUC19.gb')).toThrow(/traverse/);
    expect(() => validateWorkspaceRelativePath('sequences/../pUC19.gb')).toThrow(/traverse/);
    expect(() => validateWorkspaceRelativePath('/tmp/pUC19.gb')).toThrow(/relative/);
    expect(() => validateWorkspaceRelativePath('C:\\tmp\\pUC19.gb')).toThrow(/relative/);
    expect(() => validateWorkspaceRelativePath('sequences\\pUC19.gb')).toThrow(/forward slashes/);
  });
});

describe('workspace folder projection', () => {
  const existing: WorkspaceFolder[] = [
    { path: '/Users/me/lab', name: 'lab', addedAt: 1 },
    { path: '/Users/me/dev-fixtures', name: 'Test Fixtures', addedAt: 2, pinned: true },
  ];

  it('adds materialized roots without duplicating existing folders', () => {
    const folders = projectWorkspaceFolders(existing, sampleInstance, false, 3);

    expect(folders.map((folder) => folder.path)).toEqual([
      '/Users/me/lab',
      '/Users/me/dev-fixtures',
      '/Users/me/AppData/Sample Workspaces/standard-samples/v1/workspace',
    ]);
    expect(folders[2]).toMatchObject({ name: 'DNAForge Samples', addedAt: 3 });

    const duplicate = projectWorkspaceFolders(folders, sampleInstance, false, 4);
    expect(duplicate).toHaveLength(folders.length);
  });

  it('does not let path aliases create duplicate mounted projects', () => {
    const aliasedInstance = {
      ...sampleInstance,
      rootFolders: [{ path: '/Users/me/lab/', name: 'Renamed lab' }],
    };

    const folders = projectWorkspaceFolders(existing, aliasedInstance, false, 3);

    expect(folders.filter((folder) => folder.path.startsWith('/Users/me/lab'))).toHaveLength(1);
    expect(folders.find((folder) => folder.path === '/Users/me/lab')?.name).toBe('Renamed lab');
  });

  it('refreshes the display name when an already-mounted root is opened again', () => {
    const stale: WorkspaceFolder[] = [
      {
        path: '/Users/me/AppData/Sample Workspaces/standard-samples/v1/workspace',
        name: 'repo',
        addedAt: 1,
      },
    ];

    expect(projectWorkspaceFolders(stale, sampleInstance, false, 3)).toEqual([
      {
        path: '/Users/me/AppData/Sample Workspaces/standard-samples/v1/workspace',
        name: 'DNAForge Samples',
        addedAt: 1,
      },
    ]);
  });

  it('replaceCurrent keeps pinned roots and projects the new workspace as compatibility root', () => {
    const folders = projectWorkspaceFolders(existing, sampleInstance, true, 3);

    expect(folders.map((folder) => folder.path)).toEqual([
      '/Users/me/dev-fixtures',
      '/Users/me/AppData/Sample Workspaces/standard-samples/v1/workspace',
    ]);
    expect(selectDefaultWorkspacePath(folders)).toBe(
      '/Users/me/AppData/Sample Workspaces/standard-samples/v1/workspace'
    );
  });

  it('projects legacy current-project compatibility only when the writable project is unambiguous', () => {
    expect(selectDefaultWorkspacePath(existing)).toBe('/Users/me/lab');
    expect(selectDefaultWorkspacePath(existing.filter((folder) => folder.pinned))).toBeNull();
    expect(
      selectDefaultWorkspacePath([
        { path: '/Users/me/a', name: 'A', addedAt: 1 },
        { path: '/Users/me/b', name: 'B', addedAt: 2 },
      ])
    ).toBeNull();
  });
});

describe('openWorkspaceFromSource local-folder compatibility', () => {
  it('mounts and durably registers a reference root without promoting it to writable', async () => {
    const result = await openWorkspaceFromSource(
      { kind: 'local-folder', path: '/reference/project', name: 'Reference', pinned: true },
      { inPlace: true }
    );
    expect(result.instance.writable).toBe(false);
    expect(
      useWorkspaceStore.getState().folders.find((folder) => folder.path === '/reference/project')
        ?.pinned
    ).toBe(true);
    expect(dbMocks.requestStarted).toHaveBeenCalledWith('/reference/project', 'reference', {
      name: 'Reference',
      recordOpen: true,
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    dbMocks.finishRegistration.mockImplementation(() => Promise.resolve());
    useWorkspaceStore.setState({
      folders: [],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
  });

  it('delegates opening metadata to the native workspace owner', async () => {
    await openWorkspaceFromSource(
      {
        kind: 'local-folder',
        path: '/managed/sundew/repo',
        name: 'sundew_export_2',
      },
      { inPlace: true }
    );

    expect(dbMocks.requestStarted).toHaveBeenCalledWith('/managed/sundew/repo', undefined, {
      name: 'sundew_export_2',
      recordOpen: true,
    });
  });

  it('persists the workspace before publishing a folder that triggers catalog listing', async () => {
    let rootsAtWrite: string[] | null = null;
    dbMocks.requestStarted.mockImplementationOnce(() => {
      rootsAtWrite = useWorkspaceStore.getState().folders.map((folder) => folder.path);
    });
    await openWorkspaceFromSource(
      { kind: 'local-folder', path: '/fixture/mount-order' },
      { inPlace: true }
    );
    expect(dbMocks.requestStarted).toHaveBeenCalledOnce();
    expect(rootsAtWrite).toEqual([]);
    expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toEqual([
      '/fixture/mount-order',
    ]);
  });

  it('registers a workspace before publishing its mounted folder', async () => {
    let finishRegistration: (() => void) | undefined;
    const registrationPending = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    dbMocks.finishRegistration.mockReturnValueOnce(registrationPending);

    const opening = openWorkspaceFromSource(
      { kind: 'local-folder', path: '/Users/me/lab' },
      { inPlace: true }
    );

    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    expect(useWorkspaceStore.getState().folders).toEqual([]);

    finishRegistration?.();
    await opening;

    expect(useWorkspaceStore.getState().folders).toMatchObject([
      { path: '/Users/me/lab', name: 'lab' },
    ]);
  });

  it('does not publish a mounted folder when workspace registration fails', async () => {
    dbMocks.finishRegistration.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      openWorkspaceFromSource({ kind: 'local-folder', path: '/Users/me/lab' }, { inPlace: true })
    ).rejects.toThrow('database unavailable');

    expect(useWorkspaceStore.getState().folders).toEqual([]);
  });
  it('mounts a local folder, reveals it, and projects legacy current_workspace_path', async () => {
    const committedRoots: string[] = [];

    const result = await openWorkspaceFromSource(
      { kind: 'local-folder', path: '/Users/me/lab/' },
      { addToRecents: false },
      {
        onWorkspaceCommitted: ({ instance }) => {
          expect(useWorkspaceStore.getState().folders[0]?.path).toBe('/Users/me/lab');
          expect(useWorkspaceStore.getState().workspaceSelection.path).toBe('/Users/me/lab');
          committedRoots.push(instance.rootFolders[0].path);
        },
      }
    );

    expect(result.instance.rootFolders[0]).toMatchObject({
      path: '/Users/me/lab',
      name: 'lab',
    });
    expect(useWorkspaceStore.getState().folders).toMatchObject([
      { path: '/Users/me/lab', name: 'lab' },
    ]);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/Users/me/lab');
    expect(useWorkspaceStore.getState().workspaceSelection.path).toBe('/Users/me/lab');
    expect(committedRoots).toEqual(['/Users/me/lab']);
  });

  it('merge-opens additional local folders without overwriting an existing legacy path', async () => {
    useWorkspaceStore.setState({
      folders: [{ path: '/Users/me/current', name: 'current', addedAt: 1 }],
      expandedPaths: new Set(['/Users/me/current']),
      selectedPath: '/Users/me/current',
      workspaceSelection: { phase: 'ready', path: '/Users/me/current', error: null },
    });

    await openWorkspaceFromSource(
      { kind: 'local-folder', path: '/Users/me/other' },
      { addToRecents: false }
    );

    expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toEqual([
      '/Users/me/current',
      '/Users/me/other',
    ]);
    expect(useWorkspaceStore.getState().workspaceSelection.path).toBe('/Users/me/current');
  });

  it('reveals an asset without opening a tab', async () => {
    const openedFiles: string[] = [];

    await openWorkspaceFromSource(
      { kind: 'local-folder', path: '/Users/me/lab' },
      { addToRecents: false, revealAsset: 'sequences/circular/pUC19.gb' },
      {
        openFile: ({ filePath }) => {
          openedFiles.push(filePath);
        },
      }
    );

    expect(openedFiles).toEqual([]);
    expect(useWorkspaceStore.getState().selectedPath).toBe(
      '/Users/me/lab/sequences/circular/pUC19.gb'
    );
    expect([...useWorkspaceStore.getState().expandedPaths]).toEqual([
      '/Users/me/lab',
      '/Users/me/lab/sequences',
      '/Users/me/lab/sequences/circular',
    ]);
  });

  it('opens an asset while revealing its collapsed file-tree row', async () => {
    const openedFiles: Array<{ filePath: string; label: string }> = [];
    const packagePath = 'Benchling Imports/Notebooks/PCR optimization';
    const metadataPath = `${packagePath}/.forge/notebook.json`;

    const result = await openWorkspaceFromSource(
      { kind: 'local-folder', path: '/Users/me/lab' },
      {
        addToRecents: false,
        openAsset: metadataPath,
        revealAsset: packagePath,
        openAssetLabel: 'PCR optimization',
      },
      {
        openFile: (request) => {
          openedFiles.push(request);
        },
      }
    );

    expect(openedFiles).toEqual([
      {
        filePath: `/Users/me/lab/${metadataPath}`,
        label: 'PCR optimization',
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(result.openedAssetPath).toBe(`/Users/me/lab/${metadataPath}`);
    expect(useWorkspaceStore.getState().selectedPath).toBe(`/Users/me/lab/${packagePath}`);
  });

  it('keeps a committed workspace mounted when an optional landing asset fails to open', async () => {
    const result = await openWorkspaceFromSource(
      { kind: 'local-folder', path: '/Users/me/lab' },
      {
        addToRecents: false,
        openAsset: 'notebooks/missing.dnaforge-page',
        allowOpenAssetFailure: true,
      },
      {
        openFile: () => {
          throw new Error('landing notebook is damaged');
        },
      }
    );

    expect(result).toMatchObject({
      assetOpenError: 'landing notebook is damaged',
    });
    expect(result.openedAssetPath).toBeUndefined();
    expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toContain(
      '/Users/me/lab'
    );
  });
});

describe('current project collection ownership (F22)', () => {
  function deferredRegistration() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    dbMocks.finishRegistration.mockReturnValueOnce(promise);
    return resolve;
  }
  const open = (path: string, extra: Parameters<typeof openWorkspaceFromSource>[1] = {}) =>
    openWorkspaceFromSource(
      { kind: 'local-folder', path },
      { inPlace: true, makeCurrent: true, ...extra }
    );

  afterEach(() => {
    vi.clearAllMocks();
    dbMocks.finishRegistration.mockImplementation(() => Promise.resolve());
    useWorkspaceStore.getState().clearWorkspace();
  });

  it('retains a newer added root and selection when old registration finishes', async () => {
    const settle = deferredRegistration();
    const a = open('/fixture/a');
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    await open('/fixture/b');
    settle();
    await a;
    expect(
      useWorkspaceStore
        .getState()
        .folders.map((f) => f.path)
        .sort()
    ).toEqual(['/fixture/a', '/fixture/b']);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/b');
    expect(useWorkspaceStore.getState().workspaceSelection.path).toBe('/fixture/b');
  });

  it('does not revive a closed root or its expanded paths', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/c');
    const settle = deferredRegistration();
    const a = open('/fixture/a');
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    useWorkspaceStore.getState().removeFolder('/fixture/c');
    useWorkspaceStore.getState().addFolder('/fixture/d');
    settle();
    await a;
    expect(
      useWorkspaceStore
        .getState()
        .folders.map((f) => f.path)
        .sort()
    ).toEqual(['/fixture/a', '/fixture/d']);
    expect(useWorkspaceStore.getState().expandedPaths.has('/fixture/c')).toBe(false);
  });

  it('an older replace removes only the roots it intended to replace, preserving later additions', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/c');
    const settle = deferredRegistration();
    const a = open('/fixture/a', { replaceCurrent: true });
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    await open('/fixture/b');
    settle();
    await a;
    expect(
      useWorkspaceStore
        .getState()
        .folders.map((f) => f.path)
        .sort()
    ).toEqual(['/fixture/a', '/fixture/b']);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/b');
  });

  it('a newer replace supersedes an older pending add', async () => {
    const settle = deferredRegistration();
    const a = open('/fixture/a');
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    await open('/fixture/b', { replaceCurrent: true });
    settle();
    await a;
    expect(useWorkspaceStore.getState().folders.map((f) => f.path)).toEqual(['/fixture/b']);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/b');
  });

  it('closing a root during its pending reopen cannot revive it', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/a');
    const settle = deferredRegistration();
    const a = open('/fixture/a');
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    useWorkspaceStore.getState().removeFolder('/fixture/a');
    settle();
    await a;
    expect(useWorkspaceStore.getState().folders).toEqual([]);
  });

  it('an intervening explicit selection owns presentation', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/c');
    const settle = deferredRegistration();
    const a = open('/fixture/a');
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    useWorkspaceStore.getState().revealPath('/fixture/c');
    settle();
    await a;
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/c');
  });

  it('automatic sample mounting never seizes an existing manual selection', async () => {
    await open('/fixture/b');
    await open('/fixture/sample', { makeCurrent: false, telemetrySource: 'automatic_sample' });
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/b');
    expect(useWorkspaceStore.getState().folders).toHaveLength(2);
  });
});

describe('replace and rename retain newer root generations (F22)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    dbMocks.finishRegistration.mockImplementation(() => Promise.resolve());
    useWorkspaceStore.getState().clearWorkspace();
  });
  it('an older replacement cannot remove a later explicit reopen of an original root', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/c');
    let settle!: () => void;
    dbMocks.finishRegistration.mockReturnValueOnce(
      new Promise<void>((r) => {
        settle = r;
      })
    );
    const a = openWorkspaceFromSource(
      { kind: 'local-folder', path: '/fixture/a' },
      { inPlace: true, replaceCurrent: true }
    );
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    await openWorkspaceFromSource({ kind: 'local-folder', path: '/fixture/c' }, { inPlace: true });
    settle();
    await a;
    expect(
      useWorkspaceStore
        .getState()
        .folders.map((f) => f.path)
        .sort()
    ).toEqual(['/fixture/a', '/fixture/c']);
  });
  it('an intervening committed rename is not overwritten by a delayed open label', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/c', 'Before');
    let settle!: () => void;
    dbMocks.finishRegistration.mockReturnValueOnce(
      new Promise<void>((r) => {
        settle = r;
      })
    );
    const c = openWorkspaceFromSource(
      { kind: 'local-folder', path: '/fixture/c', name: 'Before' },
      { inPlace: true }
    );
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    useWorkspaceStore.getState().renameFolder('/fixture/c', 'Confirmed rename');
    settle();
    await c;
    expect(useWorkspaceStore.getState().folders[0].name).toBe('Confirmed rename');
  });
});

describe('landing document presentation ownership (F22)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    dbMocks.finishRegistration.mockImplementation(() => Promise.resolve());
    useWorkspaceStore.getState().clearWorkspace();
  });
  it('a newer open aborts older document preparation without rolling back either mounted root', async () => {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const preparing = new Promise<void>((r) => {
      finish = r;
    });
    const openFile = vi.fn(async (request: { signal?: AbortSignal }) => {
      signal = request.signal;
      await preparing;
    });
    const old = openWorkspaceFromSource(
      { kind: 'local-folder', path: '/fixture/a' },
      { inPlace: true, openAsset: 'controlled.txt' },
      { openFile }
    );
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
    await openWorkspaceFromSource({ kind: 'local-folder', path: '/fixture/b' }, { inPlace: true });
    expect(signal?.aborted).toBe(true);
    finish();
    const result = await old;
    expect(result.openedAssetPath).toBeUndefined();
    expect(
      useWorkspaceStore
        .getState()
        .folders.map((f) => f.path)
        .sort()
    ).toEqual(['/fixture/a', '/fixture/b']);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/b');
  });
});

describe('compatibility preference ordering (F22)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    dbMocks.finishRegistration.mockImplementation(() => Promise.resolve());
    useWorkspaceStore.getState().clearWorkspace();
  });
  it('an old preference acknowledgement cannot claim the newer pointer', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    const nativeExecute = platform().db.execute.bind(platform().db);
    const setter = vi.spyOn(platform().db, 'execute').mockImplementation(async (sql, args) => {
      if (sql.includes('settings') && args?.includes('/fixture/a')) await pending;
      return nativeExecute(sql, args);
    });
    const old = openWorkspaceFromSource(
      { kind: 'local-folder', path: '/fixture/a' },
      { inPlace: true, makeCurrent: true }
    );
    await vi.waitFor(() => expect(setter).toHaveBeenCalledOnce());
    const current = openWorkspaceFromSource(
      { kind: 'local-folder', path: '/fixture/b' },
      { inPlace: true, makeCurrent: true }
    );
    await vi.waitFor(() =>
      expect(useWorkspaceStore.getState().folders.some((f) => f.path === '/fixture/b')).toBe(true)
    );
    finish();
    await Promise.all([old, current]);
    expect(useWorkspaceStore.getState().workspaceSelection.path).toBe('/fixture/b');
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/b');
    expect(
      setter.mock.calls.filter(([sql]) => sql.includes('settings')).map(([, args]) => args?.[1])
    ).toEqual(['/fixture/a', '/fixture/b']);
  });
});

describe('explicit root collapse ownership (F22)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    dbMocks.finishRegistration.mockImplementation(() => Promise.resolve());
    useWorkspaceStore.getState().clearWorkspace();
  });
  it('a later collapse is not undone by an older pending reopen', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/c');
    let finish!: () => void;
    dbMocks.finishRegistration.mockReturnValueOnce(
      new Promise<void>((r) => {
        finish = r;
      })
    );
    const opening = openWorkspaceFromSource(
      { kind: 'local-folder', path: '/fixture/c' },
      { inPlace: true }
    );
    await vi.waitFor(() => expect(dbMocks.requestStarted).toHaveBeenCalledOnce());
    useWorkspaceStore.getState().collapsePath('/fixture/c');
    finish();
    await opening;
    expect(useWorkspaceStore.getState().expandedPaths.has('/fixture/c')).toBe(false);
    expect(useWorkspaceStore.getState().folders.map((f) => f.path)).toEqual(['/fixture/c']);
  });
});
