import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { JSONContent } from '@tiptap/core';
import { useEditorAutosave } from './hooks/useEditorAutosave';

const { artifactMocks, dbMocks, repairMock } = vi.hoisted(() => ({
  artifactMocks: {
    writeNotebookArtifactSnapshot: vi.fn(),
    renameNotebookArtifactFile: vi.fn(),
    resolveNotebookArtifactWorkspaceOwner: vi.fn(),
  },
  dbMocks: {
    execute: vi.fn(),
    replaceNotebookProjection: vi.fn(),
    mutateLegacyNotebookPage: vi.fn(),
    select: vi.fn(),
  },
  repairMock: vi.fn(),
}));

vi.mock('./entity-ref/repair-page-references', () => ({
  repairPageReferences: repairMock,
}));

vi.mock('../../db/workspace-artifacts', () => ({
  artifactStemFromFileName: (name: string) => name.replace(/\.md$/i, ''),
  renameNotebookArtifactFile: artifactMocks.renameNotebookArtifactFile,
  resolveNotebookArtifactWorkspaceOwner: artifactMocks.resolveNotebookArtifactWorkspaceOwner,
  writeNotebookArtifactSnapshot: artifactMocks.writeNotebookArtifactSnapshot,
  trashNotebookArtifactForPage: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ db: dbMocks }),
  initPlatform: vi.fn(),
}));

vi.mock('../../db/workspace-catalog', () => ({
  resolveWorkspaceId: async () => 1,
  resolveWorkspaceScope: async () => 'ws1',
  getCurrentCatalogFileForEntity: async () => null,
}));

vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: async (
    _workspaceRoot: string | null,
    operation: (mutationToken: string) => Promise<unknown>
  ) => operation('notebook-authority-token'),
}));

import { usePageStore } from './store';
import { withNotebookAuthorityOperation } from './notebook-authority-queue';

function notebookArtifact(authorityFingerprint: string) {
  return {
    authorityFingerprint,
    path: '/workspace/Lab notes',
    name: 'Lab notes',
    fileKind: 'waypoint-notebook',
    sizeBytes: 100,
  };
}

describe('page store notebook authority queue', () => {
  beforeEach(() => {
    artifactMocks.writeNotebookArtifactSnapshot.mockReset();
    artifactMocks.renameNotebookArtifactFile.mockReset();
    artifactMocks.resolveNotebookArtifactWorkspaceOwner.mockReset().mockResolvedValue({
      status: 'bound',
      workspaceRoot: '/workspace',
      path: '/workspace/Lab notes',
    });
    dbMocks.execute.mockReset().mockResolvedValue({ changes: 1, lastInsertRowid: 0 });
    dbMocks.select.mockReset().mockResolvedValue([]);
    dbMocks.replaceNotebookProjection.mockReset().mockResolvedValue(undefined);
    dbMocks.mutateLegacyNotebookPage.mockReset().mockResolvedValue(undefined);
    repairMock.mockReset().mockImplementation(async (content) => ({
      content,
      repaired: 0,
      skipped: [],
      changed: false,
    }));
    usePageStore.setState({
      pages: {
        'page-1': {
          id: 'page-1',
          title: 'Lab notes',
          content: { type: 'doc', content: [] },
          date: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      },
      pageList: [{ id: 'page-1', title: 'Lab notes', updatedAt: new Date(0) }],
      dirtyIds: new Set(['page-1']),
    });
  });

  it('keeps pending renderer edits dirty while an older autosave advances the file projection', async () => {
    let finishOlderSave!: (value: { authorityFingerprint: string }) => void;
    let finishNewerSave!: (value: { authorityFingerprint: string }) => void;
    const olderPublication = new Promise<{ authorityFingerprint: string }>((resolve) => {
      finishOlderSave = resolve;
    });
    const newerPublication = new Promise<{ authorityFingerprint: string }>((resolve) => {
      finishNewerSave = resolve;
    });
    artifactMocks.writeNotebookArtifactSnapshot
      .mockReturnValueOnce(olderPublication)
      .mockReturnValueOnce(newerPublication);
    const older: JSONContent = { type: 'doc', content: [] };
    const newer: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'newer edit' }] }],
    };
    const contentRef = { current: older };
    const { result, unmount } = renderHook(() =>
      useEditorAutosave({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        debounceMs: 10,
        contentRef,
        onSave: (content, id) =>
          usePageStore
            .getState()
            .savePage(id, content, {
              preserveDirtyState: true,
            })
            .then(() => {}),
        onDirtyTransition: (id) => usePageStore.getState().setDirty(id, true),
        onSaved: (id) => usePageStore.getState().setDirty(id, false),
      })
    );
    let olderSave: Promise<void> | undefined;
    try {
      act(() => result.current.markDirty());
      act(() => {
        olderSave = result.current.saveNow();
      });
      await waitFor(() =>
        expect(artifactMocks.writeNotebookArtifactSnapshot).toHaveBeenCalledTimes(1)
      );
      act(() => {
        contentRef.current = newer;
        result.current.markDirty();
      });
      await act(async () => {
        finishOlderSave(notebookArtifact('older'));
        await olderSave;
      });
      await waitFor(() =>
        expect(artifactMocks.writeNotebookArtifactSnapshot).toHaveBeenCalledTimes(2)
      );
      expect(usePageStore.getState().pages['page-1'].content).toEqual(older);
      expect(usePageStore.getState().dirtyIds.has('page-1')).toBe(true);
      await act(async () => {
        finishNewerSave(notebookArtifact('newer'));
      });
      await waitFor(() => expect(result.current.saveStatus).toBe('clean'));
      expect(usePageStore.getState().pages['page-1'].content).toEqual(newer);
      expect(usePageStore.getState().dirtyIds.has('page-1')).toBe(false);
    } finally {
      await act(async () => {
        finishOlderSave(notebookArtifact('older'));
        finishNewerSave(notebookArtifact('newer'));
        await olderSave;
        unmount();
      });
      await withNotebookAuthorityOperation('page-1', async () => {});
    }
  });

  it('retains the dirty editor and rejects save when native projection publication fails', async () => {
    const previous = usePageStore.getState().pages['page-1'];
    const changed = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsaved body' }] }],
    };
    artifactMocks.writeNotebookArtifactSnapshot.mockResolvedValue(
      notebookArtifact('file-was-published')
    );
    dbMocks.replaceNotebookProjection.mockRejectedValueOnce(
      new Error('native projection unavailable')
    );
    await expect(usePageStore.getState().savePage('page-1', changed)).rejects.toThrow(
      'native projection unavailable'
    );
    expect(usePageStore.getState().pages['page-1']).toBe(previous);
    expect(usePageStore.getState().dirtyIds.has('page-1')).toBe(true);
    expect(dbMocks.execute).not.toHaveBeenCalled();
  });

  it('does not start a rename until an in-flight autosave of the same page finishes', async () => {
    let finishSave: ((value: { authorityFingerprint: string }) => void) | undefined;
    artifactMocks.writeNotebookArtifactSnapshot.mockImplementationOnce(
      () =>
        new Promise<{ authorityFingerprint: string }>((resolve) => {
          finishSave = resolve;
        })
    );
    artifactMocks.renameNotebookArtifactFile.mockResolvedValue({
      id: 'page-1',
      name: 'Renamed.md',
      path: '/workspace/Renamed/Renamed.md',
      fileKind: 'waypoint-notebook',
      authorityFingerprint: 'renamed-fingerprint',
    });

    const save = usePageStore.getState().savePage('page-1', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved body' }] }],
    });
    await vi.waitFor(() => expect(artifactMocks.writeNotebookArtifactSnapshot).toHaveBeenCalled());

    const rename = usePageStore.getState().renamePageArtifact('page-1', 'Renamed');
    await Promise.resolve();
    expect(artifactMocks.renameNotebookArtifactFile).not.toHaveBeenCalled();

    finishSave?.(notebookArtifact('saved-fingerprint'));
    await save;
    expect(usePageStore.getState().dirtyIds.has('page-1')).toBe(false);
    await rename;

    expect(artifactMocks.renameNotebookArtifactFile).toHaveBeenCalledWith({
      pageId: 'page-1',
      title: 'Renamed',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved body' }] }],
      },
      mutationToken: 'notebook-authority-token',
    });
    expect(usePageStore.getState().pages['page-1']?.title).toBe('Renamed');
    expect(usePageStore.getState().pages['page-1']?.content).toMatchObject({
      content: [{ content: [{ text: 'saved body' }] }],
    });
  });

  it('persists a watcher reference repair without re-entering and deadlocking the page queue', async () => {
    const incoming = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external revision' }] }],
    };
    const repaired = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'repaired revision' }] }],
    };
    repairMock.mockResolvedValue({
      content: repaired,
      repaired: 1,
      skipped: [],
      changed: true,
    });
    artifactMocks.writeNotebookArtifactSnapshot.mockResolvedValue(
      notebookArtifact('repaired-fingerprint')
    );

    await withNotebookAuthorityOperation('page-1', () =>
      usePageStore.getState().upsertPageFromArtifact({
        id: 'page-1',
        title: 'Lab notes',
        content: incoming,
        workspaceRoot: '/workspace',
        authorityFingerprint: 'external-fingerprint',
      })
    );

    expect(artifactMocks.writeNotebookArtifactSnapshot).toHaveBeenCalledWith({
      pageId: 'page-1',
      title: 'Lab notes',
      content: repaired,
      workspaceRoot: '/workspace',
      mutationToken: 'notebook-authority-token',
      expectedCanonicalFingerprint: 'external-fingerprint',
      expectedProjectionContent: incoming,
    });
    await expect(usePageStore.getState().savePage('page-1', repaired)).resolves.toBe(
      'repaired-fingerprint'
    );
  });
});
