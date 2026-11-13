import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  settle: vi.fn(),
  acknowledge: vi.fn(),
  receive: undefined as undefined | ((requestId: string) => void),
  saveSequences: vi.fn(async () => ({ saved: 0, failed: [] })),
  tabs: [] as Array<{ id: string; type: string; entityId: string; isDirty: boolean }>,
  dirtyPaths: {} as Record<string, boolean>,
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: { settleDirtyDocuments: mocks.settle },
    app: { saveAllDone: mocks.acknowledge },
    on: (_channel: string, callback: (requestId: string) => void) => {
      mocks.receive = callback;
      return () => {
        mocks.receive = undefined;
      };
    },
  }),
}));
vi.mock('../utils/environment', () => ({ isDesktopRuntime: () => true }));
vi.mock('../features/page/store', () => ({
  usePageStore: { getState: () => ({ dirtyIds: new Set() }), subscribe: () => () => {} },
}));
vi.mock('../features/sequence/store', () => ({
  useSequenceStore: {
    getState: () => ({ dirtyPaths: mocks.dirtyPaths }),
    subscribe: () => () => {},
  },
}));
vi.mock('../features/sequence/save-all-sequences', () => ({
  saveAllDirtySequences: mocks.saveSequences,
}));
vi.mock('../features/sequence/sequence-document-client', () => ({
  getNativeSequenceDocumentClient: () => ({ owns: (id: string) => id === 'native-sequence' }),
}));
vi.mock('../features/workspace/public/file-document-client', () => ({
  ownsNativeFileDocument: (path: string) => path === '/workspace/native.txt',
}));
vi.mock('../features/canvas/store', () => ({
  useCanvasStore: {
    getState: () => ({ panels: { main: { tabs: mocks.tabs } } }),
    subscribe: () => () => {},
  },
}));
vi.mock('../features/canvas/artifact-document-lifecycle', () => ({
  saveTargetForTab: (tab: { entityId: string }) => ({ kind: 'file', filePath: tab.entityId }),
}));
vi.mock('../features/design/design-recovery', () => ({
  hasUnrecoverableDesignWork: () => [],
  useDesignRecoveryStore: { subscribe: () => () => {} },
}));
import { initSaveAllHandler } from './dirty-reporter';

it('returns each request identity only after its save operation settles', async () => {
  let finishFirst!: (value: unknown) => void;
  let finishSecond!: (value: unknown) => void;
  mocks.settle
    .mockReturnValueOnce(
      new Promise((done) => {
        finishFirst = done;
      })
    )
    .mockReturnValueOnce(
      new Promise((done) => {
        finishSecond = done;
      })
    );
  const stop = initSaveAllHandler();
  try {
    mocks.receive!('request-first');
    mocks.receive!('request-second');
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    finishSecond({ failures: [], remaining: [] });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(mocks.acknowledge.mock.calls).toEqual([['request-second']]);
    finishFirst({ failures: [], remaining: [] });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(mocks.acknowledge.mock.calls).toEqual([['request-second'], ['request-first']]);
  } finally {
    stop();
  }
});
