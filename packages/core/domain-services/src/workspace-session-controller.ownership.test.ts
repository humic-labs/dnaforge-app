import { expect, it, vi } from 'vitest';
import { WorkspaceSessionController } from './workspace-session-controller';
import type {
  WorkspaceSessionAdapter,
  WorkspaceSessionFile,
  WorkspaceSessionSnapshot,
  WorkspaceSessionRevision,
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

function deferredBytes() {
  let resolve!: (value: Uint8Array) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Uint8Array>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('publishes files to their workspace without changing the selected workspace', async () => {
  const runtime = adapter();
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-two');
  const selected = controller.getState();
  const writes = [{ path: FIRST.path, bytes: new Uint8Array([3]), contentType: FIRST.contentType }];
  await expect(
    controller.commitWorkspaceFiles({
      workspaceId: 'workspace-one',
      writes,
      expectedAccountId: 'account-one',
    })
  ).resolves.toMatchObject({ workspaceId: 'workspace-one', revisionId: 'revision-two' });
  expect(runtime.commit).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshot: expect.objectContaining({ workspaceId: 'workspace-one' }),
      writes,
      expectedAccountId: 'account-one',
    })
  );
  expect(controller.getState()).toBe(selected);
});

it('reflects a targeted write when its workspace remains selected', async () => {
  const controller = new WorkspaceSessionController(adapter());
  await controller.initialize('workspace-one');
  await controller.openFile(FIRST.path);
  await controller.commitWorkspaceFiles({
    workspaceId: 'workspace-one',
    writes: [{ path: FIRST.path, bytes: new Uint8Array([3]), contentType: FIRST.contentType }],
    expectedAccountId: 'account-one',
  });
  expect(controller.getState()).toMatchObject({
    phase: 'idle',
    activeWorkspaceId: 'workspace-one',
    activeFilePath: FIRST.path,
    snapshot: { revisionId: 'revision-two' },
    openFiles: [{ file: { contentRevision: `sha256:${'3'.repeat(64)}` } }],
  });
});

it('refuses a background write if its account changes while loading the target', async () => {
  const runtime = adapter();
  const index = await runtime.listWorkspaces();
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-two');
  let release!: (snapshot: WorkspaceSessionSnapshot) => void;
  const firstLoaded = new Promise<WorkspaceSessionSnapshot>((resolve) => {
    release = resolve;
  });
  vi.mocked(runtime.loadWorkspace).mockImplementation(async (workspace) =>
    workspace.workspaceId === 'workspace-one'
      ? firstLoaded
      : { workspaceId: workspace.workspaceId, revisionId: null, revisionNumber: 0, files: [] }
  );
  const saving = controller.commitWorkspaceFiles({
    workspaceId: 'workspace-one',
    writes: [{ path: FIRST.path, bytes: new Uint8Array([3]), contentType: FIRST.contentType }],
    expectedAccountId: 'account-one',
  });
  const refused = expect(saving).rejects.toThrow('signed-in account changed');
  await vi.waitFor(() =>
    expect(runtime.loadWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-one' })
    )
  );
  vi.mocked(runtime.listWorkspaces).mockResolvedValue({
    ...index,
    principal: { id: 'account-two', label: 'Other scientist' },
  });
  await controller.initialize('workspace-two');
  release({
    workspaceId: 'workspace-one',
    revisionId: 'revision-one',
    revisionNumber: 1,
    files: [],
  });
  await refused;
  expect(runtime.commit).not.toHaveBeenCalled();
  expect(controller.getState()).toMatchObject({
    phase: 'idle',
    principal: { id: 'account-two' },
    activeWorkspaceId: 'workspace-two',
    error: null,
  });
});

it('older file completion cannot replace the latest selected file', async () => {
  const runtime = adapter();
  const pending = deferredBytes();
  vi.mocked(runtime.readFile).mockImplementation(async ({ file }) =>
    file.path === FIRST.path ? pending.promise : new Uint8Array([2])
  );
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  const first = controller.openFile(FIRST.path);
  await controller.openFile(SECOND.path);
  pending.resolve(new Uint8Array([1]));
  await first;
  expect(controller.getState().activeFilePath).toBe(SECOND.path);
  expect(controller.getState().openFiles).toHaveLength(2);
});

it('deactivation retires a pending file activation even before a file is active', async () => {
  const runtime = adapter();
  const pending = deferredBytes();
  vi.mocked(runtime.readFile).mockReturnValue(pending.promise);
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  const first = controller.openFile(FIRST.path);
  controller.deactivateFile();
  pending.resolve(new Uint8Array([1]));
  await first;
  expect(controller.getState().activeFilePath).toBeNull();
});

it('an old failed open cannot replace the newer selected file with an error', async () => {
  const runtime = adapter();
  const pending = deferredBytes();
  vi.mocked(runtime.readFile).mockImplementation(async ({ file }) =>
    file.path === FIRST.path ? pending.promise : new Uint8Array([2])
  );
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  const first = controller.openFile(FIRST.path);
  const failure = expect(first).rejects.toThrow('old read failed');
  await controller.openFile(SECOND.path);
  pending.reject(new Error('old read failed'));
  await failure;
  expect(controller.getState()).toMatchObject({
    phase: 'idle',
    activeFilePath: SECOND.path,
    error: null,
  });
});

it('closing a pending file prevents its late completion from reopening it', async () => {
  const runtime = adapter();
  const pending = deferredBytes();
  vi.mocked(runtime.readFile).mockReturnValue(pending.promise);
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  const first = controller.openFile(FIRST.path);
  controller.closeFile(FIRST.path);
  pending.resolve(new Uint8Array([1]));
  await first;
  expect(controller.getState()).toMatchObject({ activeFilePath: null, openFiles: [] });
});

it('workspace refresh preserves a file selection made while loading', async () => {
  const runtime = adapter();
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  await controller.openFile(FIRST.path);
  await controller.openFile(SECOND.path);
  controller.activateFile(FIRST.path);
  const snapshot = controller.getState().snapshot!;
  let resolve!: (value: WorkspaceSessionSnapshot) => void;
  vi.mocked(runtime.loadWorkspace).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const refresh = controller.refreshActiveWorkspace();
  await Promise.resolve();
  controller.activateFile(SECOND.path);
  resolve(snapshot);
  await refresh;
  expect(controller.getState().activeFilePath).toBe(SECOND.path);
});

it('workspace refresh cannot reopen a file closed during its changed-content read', async () => {
  const runtime = adapter();
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  await controller.openFile(FIRST.path);
  const snapshot = controller.getState().snapshot!;
  const pending = deferredBytes();
  vi.mocked(runtime.loadWorkspace).mockResolvedValueOnce({
    ...snapshot,
    revisionId: 'new',
    files: [{ ...FIRST, contentRevision: 'changed' }, SECOND],
  });
  vi.mocked(runtime.readFile).mockImplementationOnce(() => pending.promise);
  const refresh = controller.refreshActiveWorkspace();
  await vi.waitFor(() => expect(runtime.readFile).toHaveBeenCalledTimes(2));
  controller.closeFile(FIRST.path);
  pending.resolve(new Uint8Array([4]));
  await refresh;
  expect(controller.getState()).toMatchObject({ activeFilePath: null, openFiles: [] });
});

it('only the newest history request can publish its revision list', async () => {
  const runtime = adapter();
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  let resolve!: (value: readonly WorkspaceSessionRevision[]) => void;
  vi.mocked(runtime.listHistory!).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const old = controller.loadHistory();
  await controller.loadHistory();
  const latest = controller.getState().history;
  resolve([]);
  await old;
  expect(controller.getState().history).toEqual(latest);
});

it('an older history failure cannot overwrite a newer successful history request', async () => {
  const runtime = adapter();
  const controller = new WorkspaceSessionController(runtime);
  await controller.initialize('workspace-one');
  let reject!: (error: Error) => void;
  vi.mocked(runtime.listHistory!).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      })
  );
  const old = controller.loadHistory();
  const rejected = expect(old).rejects.toThrow('old history');
  await controller.loadHistory();
  reject(new Error('old history'));
  await rejected;
  expect(controller.getState()).toMatchObject({ phase: 'idle', error: null });
});
