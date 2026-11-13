import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MANAGED_DNA_FILE_EXTENSIONS } from '@waypoint/sequence-utils/sequence-file-types';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  folders: [{ path: '/projects/research' }],
  openDialog: vi.fn(),
  runImportFlow: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    on: (channel: string, listener: () => void) => {
      mocks.listeners.set(channel, listener);
      return () => mocks.listeners.delete(channel);
    },
    dialog: { open: mocks.openDialog },
    workspace: {},
    lims: { countEntitiesByKind: vi.fn(async () => ({})) },
  }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: { folders: typeof mocks.folders; selectedPath: null }) => unknown) =>
      selector({ folders: mocks.folders, selectedPath: null }),
    { getState: () => ({ folders: mocks.folders, selectedPath: null }) }
  ),
}));
vi.mock('./run-import-flow', () => ({ runImportFlow: mocks.runImportFlow }));
vi.mock('./run-tabular-import-flow', () => ({ runTabularImportFlow: vi.fn() }));
vi.mock('../lims/public/lims-import-launch-store', () => ({
  openLimsImportFromSharedPicker: vi.fn(),
}));
vi.mock('../../db/workspace-catalog', () => ({ findWorkspaceRootForPath: vi.fn() }));
vi.mock('../../utils/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/environment')>()),
  isBrowserOnly: () => false,
}));
vi.mock('../canvas/public', () => ({
  useCanvasStore: { getState: () => ({ openChatTab: vi.fn() }) },
}));
vi.mock('../../lib/open-quick-look-source', () => ({ openQuickLookSource: vi.fn() }));

import { useImportWizard } from './useImportWizard';

beforeEach(() => {
  mocks.listeners.clear();
  mocks.openDialog.mockReset();
  mocks.openDialog.mockResolvedValue(null);
  mocks.runImportFlow.mockReset();
  mocks.runImportFlow.mockResolvedValue(undefined);
});

it('File Import Files starts with a native filter that permits PDFs and other documents', async () => {
  const sourcePath = '/Downloads/research-paper.pdf';
  mocks.openDialog.mockResolvedValue([sourcePath]);
  const hook = renderHook(() => useImportWizard());
  try {
    const importFiles = mocks.listeners.get('menu:import-files');
    expect(importFiles).toBeTypeOf('function');
    await act(async () => importFiles!());
    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalledOnce());
    const options = mocks.openDialog.mock.calls[0][0] as {
      multiple: boolean;
      filters: Array<{ name: string; extensions: string[] }>;
    };
    expect(options.multiple).toBe(true);
    expect(options.filters[0]).toEqual({ name: 'All files', extensions: ['*'] });
    await waitFor(() =>
      expect(mocks.runImportFlow).toHaveBeenCalledWith([sourcePath], expect.any(Object))
    );
  } finally {
    hook.unmount();
  }
});

it('the DNA sequences action keeps its native picker restricted to managed DNA formats', async () => {
  const hook = renderHook(() => useImportWizard());
  try {
    await act(() =>
      hook.result.current.openEntityImport({
        entityType: 'dna-sequences',
        destination: { kind: 'explicit', path: '/projects/research' },
      })
    );
    expect(mocks.openDialog).toHaveBeenCalledExactlyOnceWith({
      multiple: true,
      title: 'Import DNA sequences',
      filters: [{ name: 'DNA sequences', extensions: [...MANAGED_DNA_FILE_EXTENSIONS] }],
    });
    expect(mocks.runImportFlow).not.toHaveBeenCalled();
  } finally {
    hook.unmount();
  }
});
