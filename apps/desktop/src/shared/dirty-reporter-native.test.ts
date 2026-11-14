import { documentLifecycle } from './document-lifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  settle: vi.fn(),
  saveSequences: vi.fn(async () => ({ saved: 0, failed: [] as string[] })),
  tabs: [] as Array<{ id: string; type: string; entityId: string; isDirty: boolean }>,
  dirtyPaths: {} as Record<string, boolean>,
}));
vi.mock('../platform', () => ({
  platform: () => ({ fs: { settleDirtyDocuments: mocks.settle } }),
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
  isTabDirty: (tab: { isDirty: boolean }) => tab.isDirty,
  saveTargetForTab: (tab: { entityId: string }) => ({ kind: 'file', filePath: tab.entityId }),
}));
vi.mock('../features/design/design-recovery', () => ({
  hasUnrecoverableDesignWork: () => [],
  useDesignRecoveryStore: { subscribe: () => () => {} },
}));
import { saveAllUnsavedWork } from './dirty-reporter';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabs = [];
  mocks.dirtyPaths = {};
  mocks.settle.mockResolvedValue({
    action: 'save',
    settled: ['closed-native-document'],
    failures: [],
    remaining: [],
  });
});
describe('Save All shares the native dirty owner', () => {
  it('rejects a failed sequence save even when its batch promise resolves', async () => {
    mocks.dirtyPaths = { 'legacy-sequence': true };
    mocks.saveSequences.mockResolvedValueOnce({ saved: 0, failed: ['legacy-sequence'] });
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(saveAllUnsavedWork()).rejects.toThrow('Some documents still have unsaved work.');
      expect(report).toHaveBeenCalledWith(
        '[Save All] Sequence saves not completed:',
        { documentIds: ['legacy-sequence'], failedCount: 1 }
      );
    } finally {
      report.mockRestore();
    }
  });

  it('settles closed drafts before legacy saves and skips duplicate native views', async () => {
    mocks.dirtyPaths = { 'native-sequence': true, 'legacy-sequence': true };
    mocks.tabs = [
      { id: 'first-native-view', type: 'text', entityId: '/workspace/native.txt', isDirty: true },
      { id: 'second-native-view', type: 'text', entityId: '/workspace/native.txt', isDirty: true },
    ];
    const save = vi.spyOn(documentLifecycle, 'save');
    await saveAllUnsavedWork();
    expect(mocks.settle).toHaveBeenCalledWith({ action: 'save' });
    expect(mocks.saveSequences).toHaveBeenCalledWith({
      excludeDocumentIds: new Set(['native-sequence']),
    });
    expect(mocks.settle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveSequences.mock.invocationCallOrder[0]
    );
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });
  it('does not issue legacy saves after the native client fence refuses', async () => {
    mocks.settle.mockResolvedValue({
      action: 'save',
      settled: [],
      remaining: [],
      failures: [{ documentId: null, error: 'Pending renderer input.' }],
    });
    await expect(saveAllUnsavedWork()).rejects.toThrow('Pending renderer input.');
    expect(mocks.saveSequences).not.toHaveBeenCalled();
  });
  it('waits for the matching registered view owner', async () => {
    mocks.tabs = [{ id: 'legacy-view', type: 'text', entityId: '/legacy.txt', isDirty: true }];
    const pending = Promise.withResolvers<boolean>();
    const registration = documentLifecycle.register({
      target: { kind: 'file', filePath: '/legacy.txt' },
      tabId: 'legacy-view',
      isDirty: () => true,
      save: () => pending.promise,
    });
    let completed = false;
    try {
      const run = saveAllUnsavedWork().then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      pending.resolve(true);
      await run;
      expect(completed).toBe(true);
    } finally {
      registration.release();
    }
  });
});
