import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openFileBrowserFile } from './open-file-browser-file';
import { useCanvasStore } from '../features/canvas/public/store';

const state = vi.hoisted(() => ({ resolve: vi.fn(), toast: vi.fn() }));
vi.mock('../features/sequence/sequence-package-product', () => ({
  resolveSequencePackageProductPath: state.resolve,
}));
vi.mock('../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: state.toast }) },
}));

const ref = {
  kind: 'managed-sequence' as const,
  packageId: 'existing-native-sequence',
  packageRoot: '/project/sequences/pUC19',
};
const entry = { path: ref.packageRoot, packageKind: 'sequence' as const, sequenceDocument: ref };

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        activeTabId: 'notes',
        tabs: [
          { id: 'notes', type: 'text', entityId: '/project/notes.txt', label: 'Notes' },
          {
            id: 'existing-sequence',
            type: 'sequence',
            entityId: ref.packageId,
            label: 'pUC19',
            sequenceDocument: ref,
          },
        ],
      },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
});

describe('Files navigation to an existing managed sequence', () => {
  it('selects the existing identity before resolution while retaining the guarded open callback', async () => {
    const pending = Promise.withResolvers<string>();
    state.resolve.mockReturnValueOnce(pending.promise);
    const present = vi.fn();
    const originalTabs = useCanvasStore.getState().panels.main.tabs;
    const opening = openFileBrowserFile(entry, present);
    try {
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe('existing-sequence');
      expect(useCanvasStore.getState().panels.main.tabs).toEqual(originalTabs);
      expect(present).not.toHaveBeenCalled();
    } finally {
      pending.resolve(`${ref.packageRoot}/source.gb`);
      await opening;
    }
    expect(present).toHaveBeenCalledExactlyOnceWith(`${ref.packageRoot}/source.gb`, 'sequence');
    expect(state.toast).not.toHaveBeenCalled();
  });

  it.each([
    { ...entry, sequenceDocument: { ...ref, packageId: 'different-sequence' } },
    { ...entry, sequenceDocument: { ...ref, packageRoot: '/another/pUC19' } },
    { ...entry, path: `${ref.packageRoot}/unrelated.gb` },
    { path: entry.path, packageKind: entry.packageKind },
  ])(
    'does not infer existing identity from a label, path prefix, or incomplete reference',
    async (selected) => {
      const pending = Promise.withResolvers<string>();
      state.resolve.mockReturnValueOnce(pending.promise);
      const opening = openFileBrowserFile(selected, vi.fn());
      try {
        expect(useCanvasStore.getState().panels.main.activeTabId).toBe('notes');
      } finally {
        pending.resolve(`${ref.packageRoot}/source.gb`);
        await opening;
      }
    }
  );

  it('preserves package-resolution refusal without opening another document', async () => {
    state.resolve.mockRejectedValueOnce(new Error('Package resolution refused'));
    const present = vi.fn();
    await openFileBrowserFile(entry, present);
    expect(present).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(2);
  });
});
