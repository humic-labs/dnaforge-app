import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { HighlightGroup, Structure3dAttrs } from '../types';
import { useStructure3dStore } from '../store';

const mocks = vi.hoisted(() => ({
  saveSelection: vi.fn(),
  saveView: vi.fn(),
  rename: vi.fn(),
  record: vi.fn(),
  createView: vi.fn(),
}));

vi.mock('../utils/savedSelectionPersistence', async (importOriginal) => ({
  molecularViewBinding: (
    await importOriginal<typeof import('../utils/savedSelectionPersistence')>()
  ).molecularViewBinding,
  saveStructureSelection: mocks.saveSelection,
  saveViewBeforeSelection: mocks.saveView,
  createViewForSelection: mocks.createView,
  renameSavedSelectionRef: mocks.rename,
  recordSelectionInOpenViews: mocks.record,
}));

import { useHighlightActions } from './useHighlightActions';

const GROUP: HighlightGroup = {
  id: 'runtime-group',
  label: 'Pocket residues',
  color: '#ef4444',
  visible: true,
  selections: [{ chain: 'A', ranges: [[2, 3]] }],
};

const LOOSE: Structure3dAttrs = {
  source: 'file',
  sourceId: 'coordinates',
  label: '1FS0.pdb',
  coordinateFilePath: '/project/1FS0.pdb',
};
const LINKED: Structure3dAttrs = { source: 'pdb', sourceId: '1FS0', label: '1FS0' };
const VIEW_REF = {
  selectionId: 'selection-1',
  revisionId: 'selection-revision-1',
  artifactPath: '1FS0.dnaforge-molecular.json',
  visible: true,
};

function render(
  attrs: Structure3dAttrs,
  structureViewId?: string,
  workspaceRoot: string | null = null
) {
  const updateAttrs = vi.fn();
  const hook = renderHook(() =>
    useHighlightActions({
      highlightGroups: [],
      structureId: 'structure-1',
      updateAttrs,
      attrs,
      chains: [],
      workspaceRoot,
      savedSelectionRefs: [],
      structureViewId,
    })
  );
  return { hook, updateAttrs };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saving a selection on a structure tab that is not a view yet ', () => {
  it('publishes a completed selection to the saved view after the coordinate viewer retires', async () => {
    const savedAttrs = {
      ...LOOSE,
      molecularDocumentId: '00000000-0000-4000-8000-000000000001',
      molecularDocumentSavedReferenceId: '00000000-0000-4000-8000-000000000002',
      molecularDocumentPath: '/project/1FS0.dnaforge-molecular.json',
      molecularDocumentRevision: 'a'.repeat(64),
    };
    let complete!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      complete = resolve;
    });
    mocks.saveView.mockResolvedValue({ attrs: savedAttrs, workspaceRoot: '/project' });
    mocks.saveSelection.mockReturnValue(pending);
    const { recordSelectionInOpenViews } = await vi.importActual<
      typeof import('../utils/savedSelectionPersistence')
    >('../utils/savedSelectionPersistence');
    mocks.record.mockImplementation(recordSelectionInOpenViews);
    const { hook, updateAttrs } = render(LOOSE, 'coordinate-view');
    let saving!: Promise<void>;
    await act(async () => {
      saving = hook.result.current.handleSaveSelection(GROUP);
      await Promise.resolve();
    });
    hook.unmount();
    useStructure3dStore.setState({
      expandedStructures: {
        'molecular-document:document-1': { label: '1FS0', data: savedAttrs },
      },
    });
    try {
      await act(async () => {
        complete({
          ref: VIEW_REF,
          projection: GROUP,
          molecularDocumentPath: savedAttrs.molecularDocumentPath,
          molecularDocumentRevision: 'b'.repeat(64),
        });
        await saving;
      });
      expect(
        useStructure3dStore.getState().expandedStructures['molecular-document:document-1'].data
      ).toMatchObject({
        savedSelectionRefs: [VIEW_REF],
        molecularDocumentRevision: 'b'.repeat(64),
      });
      expect(updateAttrs).not.toHaveBeenCalled();
    } finally {
      useStructure3dStore.setState({ expandedStructures: {} });
    }
  });

  it('saves the view first and stores the selection in it', async () => {
    const savedAttrs = {
      ...LOOSE,
      molecularDocumentId: 'document-1',
      molecularDocumentPath: '/project/1FS0.dnaforge-molecular.json',
      molecularDocumentRevision: 'r1',
    };
    mocks.saveView.mockResolvedValue({ attrs: savedAttrs, workspaceRoot: '/project' });
    mocks.saveSelection.mockResolvedValue({
      ref: VIEW_REF,
      projection: GROUP,
      molecularDocumentPath: savedAttrs.molecularDocumentPath,
      molecularDocumentRevision: 'r2',
    });
    mocks.record.mockReturnValue(1);
    const { hook, updateAttrs } = render(LOOSE, 'view-1');
    await act(() => hook.result.current.handleSaveSelection(GROUP));
    expect(mocks.saveView).toHaveBeenCalledWith('view-1', LOOSE);
    expect(mocks.saveSelection).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/project', attrs: savedAttrs })
    );
    expect(mocks.record).toHaveBeenCalledWith(savedAttrs.molecularDocumentPath, VIEW_REF, 'r2');
    expect(updateAttrs).not.toHaveBeenCalled();
  });

  it('falls back to the tab when no open view matches the saved file', async () => {
    const bound = { ...LOOSE, molecularDocumentPath: '/project/1FS0.dnaforge-molecular.json' };
    mocks.saveSelection.mockResolvedValue({
      ref: VIEW_REF,
      projection: GROUP,
      molecularDocumentPath: bound.molecularDocumentPath,
      molecularDocumentRevision: 'r2',
    });
    mocks.record.mockReturnValue(0);
    const { hook, updateAttrs } = render(bound, 'view-1', '/project');
    await act(() => hook.result.current.handleSaveSelection(GROUP));
    expect(updateAttrs).toHaveBeenCalledWith({
      savedSelectionRefs: [VIEW_REF],
      molecularDocumentRevision: 'r2',
    });
  });

  it('saves a downloaded, drawer or notebook structure as a view before its first selection ', async () => {
    const savedAttrs = {
      ...LINKED,
      molecularDocumentId: 'document-2',
      molecularDocumentPath: '/project/1FS0.dnaforge-molecular.json',
      molecularDocumentRevision: 'r1',
      molecularDocumentSavedReferenceId: 'reference-1',
    };
    mocks.createView.mockResolvedValue({ attrs: savedAttrs, workspaceRoot: '/project' });
    mocks.saveSelection.mockResolvedValue({
      ref: VIEW_REF,
      projection: GROUP,
      molecularDocumentPath: savedAttrs.molecularDocumentPath,
      molecularDocumentRevision: 'r2',
    });
    mocks.record.mockReturnValue(0);
    const { hook, updateAttrs } = render(LINKED, 'view-1', '/project');
    await act(() => hook.result.current.handleSaveSelection(GROUP));
    expect(mocks.saveView).not.toHaveBeenCalled();
    expect(mocks.createView).toHaveBeenCalledWith({ workspaceRoot: '/project', attrs: LINKED });
    expect(mocks.saveSelection).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/project', attrs: savedAttrs })
    );
    expect(updateAttrs).toHaveBeenCalledWith({
      molecularDocumentId: 'document-2',
      molecularDocumentPath: '/project/1FS0.dnaforge-molecular.json',
      molecularDocumentSavedReferenceId: 'reference-1',
      savedSelectionRefs: [VIEW_REF],
      molecularDocumentRevision: 'r2',
    });
  });

  it('keeps the project requirement for a structure that cannot be saved as a view', async () => {
    const { hook } = render(LOOSE);
    await expect(hook.result.current.handleSaveSelection(GROUP)).rejects.toThrow(
      /inside a project/i
    );
    expect(mocks.saveView).not.toHaveBeenCalled();
    expect(mocks.saveSelection).not.toHaveBeenCalled();
  });

  it('does not save the view again when it is already a view file', async () => {
    const bound = { ...LOOSE, molecularDocumentPath: '/project/1FS0.dnaforge-molecular.json' };
    mocks.saveSelection.mockResolvedValue({ ref: VIEW_REF, projection: GROUP });
    const { hook } = render(bound, 'view-1', '/project');
    await act(() => hook.result.current.handleSaveSelection(GROUP));
    expect(mocks.saveView).not.toHaveBeenCalled();
    expect(mocks.saveSelection).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/project', attrs: bound })
    );
  });
});
