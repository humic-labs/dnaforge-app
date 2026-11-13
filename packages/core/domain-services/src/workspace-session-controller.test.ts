import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSessionController } from './workspace-session-controller';
import type {
  WorkspaceSessionAdapter,
  WorkspaceSessionFile,
  WorkspaceSessionSnapshot,
} from './workspace-sessions';

const FIRST: WorkspaceSessionFile = {
  resourceId: 'resource-first',
  path: 'sequences/first.gbk',
  contentRevision: `sha256:${'1'.repeat(64)}`,
  contentSha256: '1'.repeat(64),
  sizeBytes: 3,
  contentType: 'application/genbank',
};
const SECOND: WorkspaceSessionFile = {
  resourceId: 'resource-second',
  path: 'sequences/second.gbk',
  contentRevision: `sha256:${'2'.repeat(64)}`,
  contentSha256: '2'.repeat(64),
  sizeBytes: 3,
  contentType: 'application/genbank',
};

function adapter(): WorkspaceSessionAdapter {
  const snapshot: WorkspaceSessionSnapshot = {
    workspaceId: 'workspace-one',
    revisionId: 'revision-one',
    revisionNumber: 1,
    files: [FIRST, SECOND],
  };
  return {
    descriptor: {
      kind: 'hosted-browser',
      authority: 'dnaforge-manifest-revisions',
      identityFidelity: 'stable-resource-id',
      capabilities: {
        createWorkspace: true,
        multiFile: true,
        write: true,
        rename: false,
        move: false,
        delete: false,
        watch: false,
        history: true,
        restore: true,
      },
    },
    listWorkspaces: vi.fn(async () => ({
      principal: { id: 'account-one', label: 'Scientist' },
      workspaces: [
        {
          workspaceId: 'workspace-one',
          displayName: 'One',
          latestRevisionId: 'revision-one',
          latestRevisionNumber: 1,
        },
        {
          workspaceId: 'workspace-two',
          displayName: 'Two',
          latestRevisionId: null,
          latestRevisionNumber: 0,
        },
      ],
    })),
    createWorkspace: vi.fn(async (displayName) => ({
      workspaceId: 'workspace-two',
      displayName,
      latestRevisionId: null,
      latestRevisionNumber: 0,
    })),
    loadWorkspace: vi.fn(async (workspace) =>
      workspace.workspaceId === 'workspace-one'
        ? snapshot
        : { workspaceId: workspace.workspaceId, revisionId: null, revisionNumber: 0, files: [] }
    ),
    readFile: vi.fn(async ({ file }) =>
      file.path === FIRST.path ? new Uint8Array([1, 1, 1]) : new Uint8Array([2, 2, 2])
    ),
    commit: vi.fn(async ({ snapshot: base }) => ({
      ...base,
      revisionId: 'revision-two',
      revisionNumber: 2,
      files: [
        {
          ...FIRST,
          contentRevision: `sha256:${'3'.repeat(64)}`,
          contentSha256: '3'.repeat(64),
          sizeBytes: 4,
        },
        SECOND,
      ],
    })),
    listHistory: vi.fn(async () => [
      {
        revisionId: 'revision-two',
        revisionNumber: 2,
        createdAt: '2026-09-18T10:00:00.000Z',
        fileCount: 2,
        sizeBytes: 7,
      },
      {
        revisionId: 'revision-one',
        revisionNumber: 1,
        createdAt: '2026-09-18T09:00:00.000Z',
        fileCount: 2,
        sizeBytes: 6,
      },
    ]),
    restoreRevision: vi.fn(async ({ snapshot: base }) => ({
      ...base,
      revisionId: 'revision-three',
      revisionNumber: 3,
      files: [FIRST],
    })),
  };
}

describe('WorkspaceSessionController', () => {
  it('resumes an adapter selection when no current or explicit project exists', async () => {
    const runtime = adapter();
    const index = await runtime.listWorkspaces();
    vi.mocked(runtime.listWorkspaces).mockResolvedValue({
      ...index,
      preferredWorkspaceId: 'workspace-two',
    });
    const controller = new WorkspaceSessionController(runtime);
    await controller.initialize();
    expect(controller.getState().activeWorkspaceId).toBe('workspace-two');
    await controller.selectWorkspace('workspace-one');
    await controller.initialize();
    expect(controller.getState().activeWorkspaceId).toBe('workspace-one');
  });

  it('keeps explicit selection and accessible project admission ahead of an adapter hint', async () => {
    const runtime = adapter();
    const index = await runtime.listWorkspaces();
    vi.mocked(runtime.listWorkspaces).mockResolvedValue({
      ...index,
      preferredWorkspaceId: 'workspace-two',
    });
    const explicit = new WorkspaceSessionController(runtime);
    await explicit.initialize('workspace-one');
    expect(explicit.getState().activeWorkspaceId).toBe('workspace-one');
    vi.mocked(runtime.listWorkspaces).mockResolvedValue({
      ...index,
      preferredWorkspaceId: 'inaccessible-project',
    });
    const fresh = new WorkspaceSessionController(runtime);
    await fresh.initialize();
    expect(fresh.getState().activeWorkspaceId).toBe('workspace-one');
  });

  it('owns workspace selection, open-file caching, and active-tab state', async () => {
    const runtime = adapter();
    const controller = new WorkspaceSessionController(runtime);

    await controller.initialize('workspace-one');
    await controller.openFile(FIRST.path);
    await controller.openFile(SECOND.path);
    controller.activateFile(FIRST.path);

    expect(runtime.readFile).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      activeWorkspaceId: 'workspace-one',
      activeFilePath: FIRST.path,
    });
    expect(controller.getState().openFiles.map((opened) => opened.file.resourceId)).toEqual([
      'resource-first',
      'resource-second',
    ]);

    controller.deactivateFile();
    expect(controller.getState().activeFilePath).toBeNull();
    expect(controller.getState().openFiles).toHaveLength(2);

    controller.activateFile(SECOND.path);
    controller.closeFile(SECOND.path);
    expect(controller.getState().activeFilePath).toBe(FIRST.path);
    expect(controller.getState().openFiles.map((opened) => opened.file.path)).toEqual([FIRST.path]);
  });

  it('does not resolve workspace creation before a superseding initialization loads its snapshot', async () => {
    const runtime = adapter();
    const controller = new WorkspaceSessionController(runtime);
    let superseded = false;
    vi.mocked(runtime.loadWorkspace).mockImplementation(async (workspace) => {
      if (workspace.workspaceId === 'workspace-two' && !superseded) {
        superseded = true;
        void controller.initialize('workspace-one');
      }
      return workspace.workspaceId === 'workspace-one'
        ? {
            workspaceId: 'workspace-one',
            revisionId: 'revision-one',
            revisionNumber: 1,
            files: [FIRST, SECOND],
          }
        : { workspaceId: workspace.workspaceId, revisionId: null, revisionNumber: 0, files: [] };
    });

    const created = await controller.createWorkspace('Two');

    expect(created.workspaceId).toBe('workspace-two');
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      activeWorkspaceId: 'workspace-two',
      snapshot: { workspaceId: 'workspace-two', revisionId: null, files: [] },
    });
  });

  it('reads changed files back from the accepted snapshot and retains unchanged cached bytes', async () => {
    const runtime = adapter();
    const controller = new WorkspaceSessionController(runtime);
    await controller.initialize();
    await controller.openFile(FIRST.path);
    await controller.openFile(SECOND.path);
    vi.mocked(runtime.readFile).mockClear();

    const accepted = await controller.commit([
      {
        resourceId: FIRST.resourceId,
        path: FIRST.path,
        bytes: new Uint8Array([3, 3, 3, 3]),
        contentType: FIRST.contentType,
      },
    ]);

    expect(accepted.revisionId).toBe('revision-two');
    expect(runtime.readFile).toHaveBeenCalledTimes(1);
    expect(controller.getState().openFiles).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ path: FIRST.path, contentSha256: '3'.repeat(64) }),
      }),
      expect.objectContaining({ file: SECOND, bytes: new Uint8Array([2, 2, 2]) }),
    ]);
  });

  it('serializes concurrent commits so each one uses the last accepted revision', async () => {
    const runtime = adapter();
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    vi.mocked(runtime.commit).mockImplementation(async ({ snapshot: base }) => {
      callCount += 1;
      if (callCount === 1) await firstMayFinish;
      return {
        ...base,
        revisionId: callCount === 1 ? 'revision-two' : 'revision-three',
        revisionNumber: callCount + 1,
      };
    });
    const controller = new WorkspaceSessionController(runtime);
    await controller.initialize();

    const first = controller.commit([
      {
        path: FIRST.path,
        bytes: new Uint8Array([3, 3, 3]),
        contentType: FIRST.contentType,
      },
    ]);
    await vi.waitFor(() => expect(runtime.commit).toHaveBeenCalledTimes(1));
    const second = controller.commit([
      {
        path: SECOND.path,
        bytes: new Uint8Array([4, 4, 4]),
        contentType: SECOND.contentType,
      },
    ]);
    await Promise.resolve();
    expect(runtime.commit).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ revisionId: 'revision-two' });
    await expect(second).resolves.toMatchObject({ revisionId: 'revision-three' });
    expect(runtime.commit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshot: expect.objectContaining({ revisionId: 'revision-two' }) })
    );
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      snapshot: { revisionId: 'revision-three', revisionNumber: 3 },
      error: null,
    });
  });

  it('refuses a prepared aggregate edit if an earlier queued save advances its snapshot', async () => {
    const runtime = adapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runtime.commit).mockImplementation(async ({ snapshot }) => {
      await gate;
      return { ...snapshot, revisionId: 'revision-two', revisionNumber: 2 };
    });
    const controller = new WorkspaceSessionController(runtime);
    await controller.initialize();
    const preparedAgainst = controller.getState().snapshot!;
    const first = controller.commit([
      { path: FIRST.path, bytes: new Uint8Array([3]), contentType: FIRST.contentType },
    ]);
    await vi.waitFor(() => expect(runtime.commit).toHaveBeenCalledOnce());
    const prepared = controller.commit(
      [{ path: SECOND.path, bytes: new Uint8Array([4]), contentType: SECOND.contentType }],
      undefined,
      undefined,
      undefined,
      preparedAgainst
    );
    const rejected = expect(prepared).rejects.toThrow(/changed before the prepared edit/);
    release();
    await first;
    await rejected;
    expect(runtime.commit).toHaveBeenCalledOnce();
    expect(controller.getState().snapshot?.revisionId).toBe('revision-two');
  });

  it('invalidates the prior snapshot and open cache when switching workspaces', async () => {
    const controller = new WorkspaceSessionController(adapter());
    await controller.initialize();
    await controller.openFile(FIRST.path);

    await controller.selectWorkspace('workspace-two');

    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      activeWorkspaceId: 'workspace-two',
      activeFilePath: null,
      openFiles: [],
      snapshot: { workspaceId: 'workspace-two', files: [] },
    });
  });

  it('refreshes a runtime-native commit while retaining unchanged open bytes', async () => {
    const runtime = adapter();
    const controller = new WorkspaceSessionController(runtime);
    await controller.initialize();
    await controller.openFile(FIRST.path);
    await controller.openFile(SECOND.path);
    vi.mocked(runtime.readFile).mockClear();
    vi.mocked(runtime.loadWorkspace).mockResolvedValueOnce({
      workspaceId: 'workspace-one',
      revisionId: 'revision-two',
      revisionNumber: 2,
      files: [
        {
          ...FIRST,
          contentRevision: `sha256:${'3'.repeat(64)}`,
          contentSha256: '3'.repeat(64),
          sizeBytes: 4,
        },
        SECOND,
      ],
    });
    vi.mocked(runtime.readFile).mockResolvedValueOnce(new Uint8Array([3, 3, 3, 3]));

    await controller.refreshActiveWorkspace();

    expect(runtime.readFile).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      snapshot: { revisionId: 'revision-two' },
      activeFilePath: SECOND.path,
    });
    expect(controller.getState().openFiles[1]).toEqual(
      expect.objectContaining({ file: SECOND, bytes: new Uint8Array([2, 2, 2]) })
    );
  });

  it.each(['refresh', 'restore'] as const)(
    'reads the new snapshot rather than a same-path stale cache during %s',
    async (operation) => {
      const runtime = adapter();
      const controller = new WorkspaceSessionController(runtime);
      await controller.initialize();
      await controller.openFile(FIRST.path);
      await controller.loadHistory();
      const updatedFile = {
        ...FIRST,
        contentRevision: `sha256:${'3'.repeat(64)}`,
        contentSha256: '3'.repeat(64),
      };
      const accepted: WorkspaceSessionSnapshot = {
        workspaceId: 'workspace-one',
        revisionId: 'revision-three',
        revisionNumber: 3,
        files: [updatedFile],
      };
      vi.mocked(runtime.loadWorkspace).mockResolvedValue(accepted);
      vi.mocked(runtime.restoreRevision!).mockResolvedValue(accepted);
      vi.mocked(runtime.readFile).mockImplementation(async ({ snapshot }) =>
        snapshot.revisionId === 'revision-three'
          ? new Uint8Array([3, 3, 3])
          : new Uint8Array([1, 1, 1])
      );
      let readStarted = false;
      let observed!: ReturnType<typeof controller.openFile>;
      controller.subscribe(() => {
        if (readStarted || controller.getState().snapshot?.revisionId !== 'revision-three') return;
        readStarted = true;
        observed = controller.openFile(FIRST.path);
      });

      if (operation === 'restore') await controller.restoreRevision('revision-one');
      else await controller.refreshActiveWorkspace();

      expect(readStarted).toBe(true);
      await expect(observed).resolves.toEqual({
        file: updatedFile,
        bytes: new Uint8Array([3, 3, 3]),
      });
      expect(controller.getState().openFiles).toEqual([
        { file: updatedFile, bytes: new Uint8Array([3, 3, 3]) },
      ]);
    }
  );

  it('retains the accepted revision when changed-file read-back fails after publication', async () => {
    const runtime = adapter();
    const controller = new WorkspaceSessionController(runtime);
    await controller.initialize();
    await controller.openFile(FIRST.path);
    vi.mocked(runtime.readFile).mockRejectedValueOnce(new Error('temporary download failure'));

    await expect(
      controller.commit([
        {
          path: FIRST.path,
          bytes: new Uint8Array([3, 3, 3, 3]),
          contentType: FIRST.contentType,
        },
      ])
    ).resolves.toMatchObject({ revisionId: 'revision-two' });

    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      error: null,
      refreshError: new Error('temporary download failure'),
      snapshot: { revisionId: 'revision-two', revisionNumber: 2 },
    });
  });

  it('loads immutable history and restores it as a new accepted revision', async () => {
    const runtime = adapter();
    const controller = new WorkspaceSessionController(runtime);
    await controller.initialize();
    await controller.openFile(FIRST.path);
    await controller.openFile(SECOND.path);

    const history = await controller.loadHistory();
    expect(history.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(controller.getState().history).toEqual(history);

    const accepted = await controller.restoreRevision('revision-one');
    expect(runtime.restoreRevision).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: 'revision-one' })
    );
    expect(accepted.revisionId).toBe('revision-three');
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      snapshot: { revisionId: 'revision-three', revisionNumber: 3 },
      activeFilePath: FIRST.path,
      history: [],
    });
    expect(controller.getState().openFiles.map((opened) => opened.file.path)).toEqual([FIRST.path]);
  });
});
