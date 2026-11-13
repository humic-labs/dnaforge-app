import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  deferNativeDocumentWorkspaceStartup,
  installNativeDocumentWorkspacePublisher,
} from './native-document-workspaces';

const mocks = vi.hoisted(() => ({
  folders: [] as Array<{ path: string; name: string; pinned?: boolean }>,
  listeners: new Set<() => void>(),
  send: vi.fn().mockResolvedValue(true),
  installSync: vi.fn(),
  stopSync: vi.fn(),
  setReadiness: vi.fn(),
  migrate: vi.fn().mockResolvedValue(undefined),
  installSequence: vi.fn(),
  stopSequence: vi.fn(),
  migrateSequence: vi.fn().mockResolvedValue(undefined),
  migrateNotebook: vi.fn().mockResolvedValue(undefined),
  refreshSequences: vi.fn(),
}));
vi.mock('../features/workspace/public/file-document-client', () => ({
  installFileDocumentClientSync: mocks.installSync,
  setNativeFileDocumentReadiness: mocks.setReadiness,
}));
vi.mock('../features/workspace/file-document-legacy-client', () => ({
  migrateLegacyFileDrafts: mocks.migrate,
}));
vi.mock('../features/sequence/sequence-document-client', () => ({
  installNativeSequenceDocumentClient: mocks.installSequence,
  getNativeSequenceDocumentClient: () => ({ refreshAvailableDocuments: mocks.refreshSequences }),
}));
vi.mock('../features/sequence/store', () => ({ sequenceDocumentModel: {} }));
vi.mock('../features/sequence/legacy-sequence-recovery-client', () => ({
  migrateLegacySequenceDrafts: mocks.migrateSequence,
}));
vi.mock('../features/page/notebook-document-client', () => ({
  migrateLegacyNotebookDrafts: mocks.migrateNotebook,
}));
vi.mock('./native-notebook-catalog-publisher', () => ({
  installNativeNotebookCatalogPublisher: () => () => {},
}));
vi.mock('../platform', () => ({
  platform: () => ({ workspace: { setDocumentCommandRoots: mocks.send } }),
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

beforeEach(() => {
  mocks.folders = [];
  mocks.listeners.clear();
  mocks.send.mockReset().mockResolvedValue(true);
  mocks.installSync.mockReset().mockReturnValue(mocks.stopSync);
  mocks.stopSync.mockReset();
  mocks.setReadiness.mockReset();
  mocks.migrate.mockReset().mockResolvedValue(undefined);
  mocks.installSequence.mockReset().mockReturnValue(mocks.stopSequence);
  mocks.stopSequence.mockReset();
  mocks.migrateSequence.mockReset().mockResolvedValue(undefined);
  mocks.migrateNotebook.mockReset().mockResolvedValue(undefined);
  mocks.refreshSequences.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it('publishes writable workspace membership independently of names, order and sequence views', () => {
  mocks.folders = [
    { path: '/work', name: 'Project' },
    { path: '/reference', name: 'Reference', pinned: true },
  ];
  const stop = installNativeDocumentWorkspacePublisher('load-1');
  expect(mocks.send).toHaveBeenLastCalledWith({
    loadId: 'load-1',
    roots: ['/work'],
    readableRoots: ['/reference', '/work'],
  });
  expect(mocks.installSync).toHaveBeenCalledExactlyOnceWith('load-1');
  mocks.folders = [...mocks.folders].reverse().map((folder) => ({ ...folder, name: 'Renamed' }));
  for (const listener of mocks.listeners) listener();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  mocks.folders = [{ path: '/reference', name: 'Reference', pinned: true }];
  for (const listener of mocks.listeners) listener();
  expect(mocks.send).toHaveBeenLastCalledWith({
    loadId: 'load-1',
    roots: [],
    readableRoots: ['/reference'],
  });
  stop();
  expect(mocks.listeners.size).toBe(0);
  expect(mocks.stopSync).toHaveBeenCalledOnce();
  expect(mocks.stopSequence).toHaveBeenCalledOnce();
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it('keeps the latest folder snapshot when enrollment requests overlap', async () => {
  let finish = () => {};
  mocks.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  mocks.folders = [{ path: '/old', name: 'Old' }];
  const stop = installNativeDocumentWorkspacePublisher('load-2');
  mocks.folders = [{ path: '/new', name: 'New' }];
  for (const listener of mocks.listeners) listener();
  finish();
  await Promise.resolve();
  expect(mocks.send.mock.calls.map(([request]) => request.roots)).toEqual([['/old'], ['/new']]);
  stop();
});

it('reconnects cached sequences only after the current workspace enrollment is ready', async () => {
  let finish!: () => void;
  mocks.send.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = () => resolve(true);
      })
  );
  mocks.folders = [{ path: '/work', name: 'Work' }];
  const stop = installNativeDocumentWorkspacePublisher('load-reconnect');
  try {
    expect(mocks.refreshSequences).not.toHaveBeenCalled();
    finish();
    await mocks.setReadiness.mock.calls.at(-1)![0];
    expect(mocks.refreshSequences).toHaveBeenCalledOnce();
    expect(mocks.migrateSequence).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it('does not reconnect sequences from a superseded workspace enrollment', async () => {
  let finishOld!: () => void, finishCurrent!: () => void;
  mocks.send
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishOld = () => resolve(true);
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishCurrent = () => resolve(true);
        })
    );
  mocks.folders = [{ path: '/old', name: 'Old' }];
  const stop = installNativeDocumentWorkspacePublisher('load-reconnect-replaced');
  const oldReadiness = mocks.setReadiness.mock.calls.at(-1)![0];
  mocks.folders = [{ path: '/current', name: 'Current' }];
  for (const listener of mocks.listeners) listener();
  const currentReadiness = mocks.setReadiness.mock.calls.at(-1)![0];
  try {
    finishOld();
    await oldReadiness;
    expect(mocks.refreshSequences).not.toHaveBeenCalled();
    finishCurrent();
    await currentReadiness;
    expect(mocks.refreshSequences).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it('defers native startup without requiring Promise.withResolvers', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
  Object.defineProperty(Promise, 'withResolvers', { configurable: true, value: undefined });
  try {
    const release = deferNativeDocumentWorkspaceStartup();
    const ready = mocks.setReadiness.mock.calls.at(-1)![0] as Promise<void>;
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await ready;
    expect(settled).toBe(true);
  } finally {
    if (descriptor) Object.defineProperty(Promise, 'withResolvers', descriptor);
    else Reflect.deleteProperty(Promise, 'withResolvers');
  }
});
