import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  folders: [{ path: '/projects/research', name: 'Research' }],
  selectedPath: '/projects/research/experiments',
  openDialog: vi.fn(),
  readTextFile: vi.fn(),
  buildState: vi.fn(),
  runImportFlow: vi.fn(),
  runTabularImportFlow: vi.fn(),
  openEntityImport: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    on: (channel: string, listener: () => void) => {
      mocks.listeners.set(channel, listener);
      return () => mocks.listeners.delete(channel);
    },
    dialog: { open: mocks.openDialog },
    fs: { readTextFile: mocks.readTextFile },
    workspace: {},
    lims: { countEntitiesByKind: vi.fn(async () => ({})) },
  }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ folders: mocks.folders, selectedPath: mocks.selectedPath }),
    { getState: () => ({ folders: mocks.folders, selectedPath: mocks.selectedPath }) }
  ),
}));
vi.mock('./build-import-wizard-state', () => ({ buildImportWizardState: mocks.buildState }));
vi.mock('./run-import-flow', () => ({ runImportFlow: mocks.runImportFlow }));
vi.mock('./run-tabular-import-flow', () => ({ runTabularImportFlow: mocks.runTabularImportFlow }));
vi.mock('../lims/public/lims-import-launch-store', () => ({
  openLimsImportFromSharedPicker: mocks.openEntityImport,
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
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.openDialog.mockResolvedValue(['/Downloads/strains.csv']);
  mocks.readTextFile.mockResolvedValue('Name,Genotype\nImported strain,deltaA');
  mocks.buildState.mockResolvedValue({ items: [] });
  mocks.runImportFlow.mockImplementation(async (paths, deps) => {
    await deps.buildState(paths);
    return null;
  });
});

it('a general spreadsheet selection enters common review with its project context intact', async () => {
  const hook = renderHook(() => useImportWizard());
  try {
    await act(async () => mocks.listeners.get('menu:import-files')!());
    await waitFor(() =>
      expect(mocks.runImportFlow).toHaveBeenCalledWith(
        ['/Downloads/strains.csv'],
        expect.any(Object)
      )
    );
    expect(mocks.buildState).toHaveBeenCalledWith(
      ['/Downloads/strains.csv'],
      expect.objectContaining({
        folders: mocks.folders,
        selectedPath: '/projects/research/experiments',
      })
    );
    expect(mocks.runTabularImportFlow).not.toHaveBeenCalled();
    expect(mocks.openEntityImport).not.toHaveBeenCalled();
  } finally {
    hook.unmount();
  }
});

it('an explicitly chosen scientific type retains its existing type and destination', async () => {
  const hook = renderHook(() => useImportWizard());
  try {
    await act(() =>
      hook.result.current.openEntityImport({
        entityType: 'strains',
        destination: { kind: 'explicit', path: '/projects/research/experiments' },
      })
    );
    expect(mocks.openEntityImport).toHaveBeenCalledExactlyOnceWith(
      'strain',
      '/projects/research/experiments'
    );
    expect(mocks.openDialog).not.toHaveBeenCalled();
    expect(mocks.runImportFlow).not.toHaveBeenCalled();
    expect(mocks.runTabularImportFlow).not.toHaveBeenCalled();
  } finally {
    hook.unmount();
  }
});
