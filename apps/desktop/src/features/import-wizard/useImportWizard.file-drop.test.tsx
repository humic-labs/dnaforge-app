import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportFlowDeps } from './run-import-flow';

const mocks = vi.hoisted(() => ({
  getPathForFile: vi.fn(),
  openDialog: vi.fn(),
  openExternalFiles: vi.fn(),
  runImportFlow: vi.fn(),
}));

vi.mock('./run-import-flow', () => ({ runImportFlow: mocks.runImportFlow }));

vi.mock('../../platform', () => ({
  platform: () => ({
    on: () => () => undefined,
    dialog: { open: mocks.openDialog },
    workspace: {
      getPathForFile: mocks.getPathForFile,
    },
    lims: {
      countEntitiesByKind: vi.fn(async () => ({})),
    },
  }),
}));

vi.mock('../../lib/open-external-preview', () => ({
  openExternalFiles: mocks.openExternalFiles,
}));

vi.mock('../../utils/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/environment')>()),
  isBrowserOnly: () => false,
}));

vi.mock('../canvas', () => ({
  useCanvasStore: {
    getState: () => ({ openChatTab: vi.fn() }),
  },
}));

import { useImportWizard } from './useImportWizard';

function fileDrop(...files: File[]): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types: ['Files'], dropEffect: 'none' },
  });
  return event;
}

describe('useImportWizard window file-drop boundary', () => {
  beforeEach(() => {
    mocks.getPathForFile.mockReset();
    mocks.openDialog.mockReset();
    mocks.openDialog.mockResolvedValue(null);
    mocks.openExternalFiles.mockReset();
    mocks.openExternalFiles.mockResolvedValue(undefined);
    mocks.runImportFlow.mockReset();
  });

  it('announces one completion batch containing every written path across projects', async () => {
    mocks.openDialog.mockResolvedValue(['/drop/real.dna']);
    mocks.runImportFlow.mockImplementation(async (_paths: string[], deps: ImportFlowDeps) => {
      deps.onComplete?.({
        imported: 2,
        skipped: 1,
        failed: 0,
        errors: [],
        workspaceRoot: '/cloning',
        touchedRoots: ['/cloning', '/yeast'],
        written: [
          { sourcePath: '/drop/real.dna', destPath: '/cloning/imports/pUC19/pUC19.gb' },
          { sourcePath: '/drop/real.dnas', destPath: '/yeast/experiments/CDC28/CDC28.gb' },
        ],
      });
    });
    const changes = vi.fn();
    window.addEventListener('waypoint:workspace-files-changed', changes);
    try {
      const { result } = renderHook(() => useImportWizard());
      await act(() =>
        result.current.openEntityImport({
          entityType: 'dna-sequences',
          destination: { kind: 'explicit', path: '/cloning' },
        })
      );
      expect(changes).toHaveBeenCalledOnce();
      expect((changes.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        workspaceRoot: '/cloning',
        workspaceRoots: ['/cloning', '/yeast'],
        revealPaths: ['/cloning/imports/pUC19/pUC19.gb', '/yeast/experiments/CDC28/CDC28.gb'],
      });
    } finally {
      window.removeEventListener('waypoint:workspace-files-changed', changes);
    }
  });

  it('recovers the native path from DataTransfer.files and opens an unclaimed GenBank drop', async () => {
    const sourcePath = '/Users/scientist/Downloads/assembly.gbk';
    const file = new File(['LOCUS'], 'assembly.gbk');
    mocks.getPathForFile.mockReturnValue(sourcePath);
    renderHook(() => useImportWizard());
    const event = fileDrop(file);

    act(() => window.dispatchEvent(event));

    await waitFor(() =>
      expect(mocks.openExternalFiles).toHaveBeenCalledWith([sourcePath], 'unknown')
    );
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.getPathForFile).toHaveBeenCalledWith(file);
  });

  it('previews every supported file in a drop without starting an import', async () => {
    mocks.getPathForFile.mockImplementation((file: File) => `/selected/${file.name}`);
    renderHook(() => useImportWizard());
    act(() => window.dispatchEvent(fileDrop(new File([], 'one.gb'), new File([], 'two.dna'))));
    await waitFor(() =>
      expect(mocks.openExternalFiles).toHaveBeenCalledWith(
        ['/selected/one.gb', '/selected/two.dna'],
        'unknown'
      )
    );
    expect(mocks.runImportFlow).not.toHaveBeenCalled();
  });

  it('does not also open a file drop already claimed by another surface', async () => {
    const file = new File(['LOCUS'], 'claimed.gbk');
    mocks.getPathForFile.mockReturnValue('/Users/scientist/Downloads/claimed.gbk');
    renderHook(() => useImportWizard());
    const event = fileDrop(file);
    event.preventDefault();

    act(() => window.dispatchEvent(event));
    await Promise.resolve();

    expect(mocks.getPathForFile).not.toHaveBeenCalled();
    expect(mocks.openExternalFiles).not.toHaveBeenCalled();
  });

  it('lets Import with agent choose one ZIP archive or one folder', async () => {
    const { result } = renderHook(() => useImportWizard());

    await act(() => result.current.openProjectImport({ agentRequested: true }));

    expect(mocks.openDialog).toHaveBeenCalledWith({
      fileOrDirectory: true,
      multiple: false,
      title: 'Choose a project folder or ZIP for the agent to organize',
      filters: [{ name: 'Zipped folders', extensions: ['zip'] }],
    });
  });

  it('keeps plain project import folder-only', async () => {
    const { result } = renderHook(() => useImportWizard());

    await act(() => result.current.openProjectImport());

    expect(mocks.openDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Import a project',
    });
  });
});
