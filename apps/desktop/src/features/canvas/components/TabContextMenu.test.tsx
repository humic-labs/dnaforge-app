/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TabContextMenu } from './TabContextMenu';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { CommandScopeProvider, COMMAND_IDS, useCommandHandler } from '../../../commands';

vi.mock('../../../services/entity-registry-reference', () => ({
  resolveEntityRegistryReference: vi.fn().mockResolvedValue(null),
}));

const canvasMocks = vi.hoisted(() => ({
  state: {
    panels: {},
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeTabsToRight: vi.fn(),
    closeSavedTabs: vi.fn(),
    closeAllTabs: vi.fn(),
    joinAllPanels: vi.fn(),
    mergePanels: vi.fn(),
    splitAndMoveTab: vi.fn(),
  } as Record<string, unknown>,
}));

const catalogMocks = vi.hoisted(() => ({
  getCurrentCatalogFileForEntity: vi.fn(),
  getCurrentSequenceFileForDocumentId: vi.fn(async () => null),
}));

vi.mock('../store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(canvasMocks.state),
    { getState: () => canvasMocks.state }
  ),
}));

vi.mock('../../../db/workspace-catalog', () => ({
  getCurrentCatalogFileForEntity: catalogMocks.getCurrentCatalogFileForEntity,
  getCurrentSequenceFileForDocumentId: catalogMocks.getCurrentSequenceFileForDocumentId,
}));

function WorkspaceRevealCommandHandler() {
  useCommandHandler<{ path: string }>(COMMAND_IDS.workspaceRevealPath, ({ payload }) => {
    if (!payload?.path) return false;
    useWorkspaceStore.getState().revealPath(payload.path);
    return true;
  });
  return null;
}

function renderContextMenu(onClose: () => void): void {
  render(
    <CommandScopeProvider>
      <WorkspaceRevealCommandHandler />
      <TabContextMenu position={{ x: 0, y: 0 }} tabId="tab-1" panelId="main" onClose={onClose} />
    </CommandScopeProvider>
  );
}

describe('TabContextMenu workspace reveal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogMocks.getCurrentCatalogFileForEntity.mockResolvedValue(null);
    useWorkspaceStore.setState({
      folders: [],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    canvasMocks.state = {
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'tab-1',
              type: 'page',
              entityId: 'page-1',
              label: 'Notebook',
            },
          ],
          activeTabId: 'tab-1',
        },
      },
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      closeTabsToRight: vi.fn(),
      closeSavedTabs: vi.fn(),
      closeAllTabs: vi.fn(),
      joinAllPanels: vi.fn(),
      mergePanels: vi.fn(),
      splitAndMoveTab: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('routes dirty-capable close actions through the shared close coordinator', () => {
    canvasMocks.state = {
      ...canvasMocks.state,
      panels: {
        main: {
          id: 'main',
          tabs: [
            { id: 'tab-1', type: 'design', entityId: 'design-1', label: 'One' },
            { id: 'tab-2', type: 'primer', entityId: 'primer-1', label: 'Two', isDirty: true },
          ],
          activeTabId: 'tab-1',
        },
      },
    };
    const requests: Array<{ panelId: string; tabIds: string[] }> = [];
    const capture = (event: WindowEventMap['artifact-document-close-request']) => {
      requests.push(event.detail);
    };
    window.addEventListener('artifact-document-close-request', capture);

    renderContextMenu(vi.fn());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close other tabs in this pane' }));

    expect(requests).toEqual([{ panelId: 'main', tabIds: ['tab-2'] }]);
    expect(canvasMocks.state.closeOtherTabs).not.toHaveBeenCalled();
    window.removeEventListener('artifact-document-close-request', capture);
  });

  it('routes Close Saved through the coordinator so pristine drafts are discarded', () => {
    canvasMocks.state = {
      ...canvasMocks.state,
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'tab-1',
              type: 'design',
              entityId: 'assembly-draft:1',
              label: 'Untitled Assembly',
              artifactDocument: {
                kind: 'assembly',
                persistence: 'draft',
                workspaceRoot: '/workspace',
                destinationPath: '/workspace',
              },
            },
            {
              id: 'dirty-tab',
              type: 'text',
              entityId: '/lab/notes.txt',
              label: 'Notes',
              isDirty: true,
            },
          ],
          activeTabId: 'draft-tab',
        },
      },
    };
    const capture = vi.fn();
    window.addEventListener('artifact-document-close-request', capture);

    renderContextMenu(vi.fn());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Saved' }));

    expect((capture.mock.calls[0][0] as CustomEvent).detail).toEqual({
      panelId: 'main',
      tabIds: ['tab-1'],
    });
    window.removeEventListener('artifact-document-close-request', capture);
  });

  it.each(['Close', 'Close All'])(
    'routes %s through confirmation when a view is unsaved',
    async (label) => {
      canvasMocks.state.panels = {
        main: {
          id: 'main',
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              type: 'sequence',
              entityId: 'track-view-unsaved1',
              label: 'Unsaved view',
              isDirty: true,
            },
          ],
        },
      };
      const request = vi.fn();
      window.addEventListener('artifact-document-close-request', request);
      renderContextMenu(vi.fn());
      await act(async () => undefined);
      fireEvent.click(screen.getByText(label, { exact: true }));
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][0].detail).toEqual({ panelId: 'main', tabIds: ['tab-1'] });
      expect(canvasMocks.state.closeTab).not.toHaveBeenCalled();
      expect(canvasMocks.state.closeAllTabs).not.toHaveBeenCalled();
      window.removeEventListener('artifact-document-close-request', request);
    }
  );

  it('reveals a managed sequence package from its logical document reference', async () => {
    useWorkspaceStore.setState({
      folders: [{ path: '/lab', name: 'lab', addedAt: 0 }],
      expandedPaths: new Set(),
      selectedPath: null,
    });
    canvasMocks.state = {
      ...canvasMocks.state,
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'tab-1',
              type: 'sequence',
              entityId: 'sequence-1',
              label: 'plasmid',
              sequenceDocument: {
                kind: 'managed-sequence',
                packageId: 'sequence-1',
                packageRoot: '/lab/sequences/plasmid-package',
              },
            },
          ],
          activeTabId: 'tab-1',
        },
      },
    };
    const onClose = vi.fn();

    renderContextMenu(onClose);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Project' }));

    await waitFor(() => {
      expect(useWorkspaceStore.getState().selectedPath).toBe('/lab/sequences/plasmid-package');
    });
    expect(useWorkspaceStore.getState().expandedPaths.has('/lab/sequences')).toBe(true);
    expect(catalogMocks.getCurrentCatalogFileForEntity).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('reveals an html tab directly  — entityId is the file path, no catalog lookup)', async () => {
    useWorkspaceStore.setState({
      folders: [{ path: '/lab', name: 'lab', addedAt: 0 }],
      expandedPaths: new Set(),
      selectedPath: null,
    });
    canvasMocks.state = {
      ...canvasMocks.state,
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'tab-1',
              type: 'html',
              entityId: '/lab/reports/qc.html',
              label: 'qc.html',
            },
          ],
          activeTabId: 'tab-1',
        },
      },
    };
    const onClose = vi.fn();

    renderContextMenu(onClose);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Project' }));

    await waitFor(() => {
      expect(useWorkspaceStore.getState().selectedPath).toBe('/lab/reports/qc.html');
    });
    expect(useWorkspaceStore.getState().expandedPaths.has('/lab/reports')).toBe(true);
    expect(catalogMocks.getCurrentCatalogFileForEntity).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('reveals folder-name-prefixed direct file tabs through the real workspace store', async () => {
    useWorkspaceStore.setState({
      folders: [
        { path: '/Users/scientist/workspace/project', name: 'project', addedAt: 0 },
        {
          path: '/Users/scientist/workspace/wp-assets',
          name: 'Dev Assets',
          addedAt: 1,
          pinned: true,
        },
      ],
      expandedPaths: new Set(),
      selectedPath: null,
    });
    canvasMocks.state = {
      ...canvasMocks.state,
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'tab-1',
              type: 'file',
              entityId: 'Dev Assets/sequences/local/pUC19.gb',
              label: 'pUC19.gb',
            },
          ],
          activeTabId: 'tab-1',
        },
      },
    };
    const onClose = vi.fn();

    renderContextMenu(onClose);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Project' }));

    await waitFor(() => {
      expect(useWorkspaceStore.getState().selectedPath).toBe(
        '/Users/scientist/workspace/wp-assets/sequences/local/pUC19.gb'
      );
    });
    expect(
      useWorkspaceStore.getState().expandedPaths.has('/Users/scientist/workspace/wp-assets')
    ).toBe(true);
    expect(
      useWorkspaceStore
        .getState()
        .expandedPaths.has('/Users/scientist/workspace/wp-assets/sequences')
    ).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    {
      type: 'page',
      entityId: 'page-1',
      label: 'Notebook',
      catalogPath: '/lab/notebooks/Untitled',
    },
    {
      type: 'design',
      entityId: 'design-1',
      label: 'Assembly',
      catalogPath: '/lab/designs/Assembly.wpdesign.json',
    },
  ] as const)('resolves $type tabs through the catalog before revealing them', async (tab) => {
    useWorkspaceStore.setState({
      folders: [{ path: '/lab', name: 'lab', addedAt: 0 }],
      expandedPaths: new Set(),
      selectedPath: null,
    });
    canvasMocks.state = {
      ...canvasMocks.state,
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'tab-1',
              type: tab.type,
              entityId: tab.entityId,
              label: tab.label,
            },
          ],
          activeTabId: 'tab-1',
        },
      },
    };
    catalogMocks.getCurrentCatalogFileForEntity.mockResolvedValue({
      path: tab.catalogPath,
    });
    const onClose = vi.fn();

    renderContextMenu(onClose);

    const item = screen.getByRole('menuitem', { name: 'Show in Project' });
    expect(catalogMocks.getCurrentCatalogFileForEntity).not.toHaveBeenCalled();
    fireEvent.click(item);
    await waitFor(() =>
      expect(catalogMocks.getCurrentCatalogFileForEntity).toHaveBeenCalledWith(tab.entityId)
    );

    await waitFor(() => {
      expect(useWorkspaceStore.getState().selectedPath).toBe(tab.catalogPath);
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe('TabContextMenu rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogMocks.getCurrentCatalogFileForEntity.mockResolvedValue(null);
    canvasMocks.state = {
      panels: {},
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      closeTabsToRight: vi.fn(),
      closeSavedTabs: vi.fn(),
      closeAllTabs: vi.fn(),
      joinAllPanels: vi.fn(),
      mergePanels: vi.fn(),
      splitAndMoveTab: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  async function renderForTab(
    tab: {
      id: string;
      type: string;
      entityId: string;
      label: string;
      readOnly?: boolean;
      sequenceDocument?: {
        kind: string;
        packageId?: string;
        packageRoot?: string;
        entityId?: string;
      };
    },
    handlers: {
      onStartRename?: (tabId: string) => void;
      onSelectTab?: (tabId: string) => void;
      onRenameManagedSequence?: (tabId: string) => void;
    } = {}
  ) {
    canvasMocks.state = {
      ...canvasMocks.state,
      panels: {
        main: {
          id: 'main',
          tabs: [tab],
          activeTabId: tab.id,
        },
      },
    };
    render(
      <CommandScopeProvider>
        <TabContextMenu
          position={{ x: 0, y: 0 }}
          tabId={tab.id}
          panelId="main"
          onClose={vi.fn()}
          onStartRename={handlers.onStartRename}
          onSelectTab={handlers.onSelectTab}
          onRenameManagedSequence={handlers.onRenameManagedSequence}
        />
      </CommandScopeProvider>
    );
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('keeps inline rename for a notebook tab', async () => {
    const onStartRename = vi.fn();
    await renderForTab(
      { id: 'tab-1', type: 'page', entityId: 'page-1', label: 'Notebook' },
      { onStartRename }
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(onStartRename).toHaveBeenCalledWith('tab-1');
  });

  it('keeps Rename disabled for a draft assembly tab', async () => {
    await renderForTab({
      id: 'tab-1',
      type: 'design',
      entityId: 'design-1',
      label: 'Draft assembly',
    });

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDisabled();
  });

  it('keeps Rename disabled for a read-only plasmid', async () => {
    await renderForTab({
      id: 'tab-1',
      type: 'sequence',
      entityId: 'pkg-plasmid',
      label: 'pAssembled',
      readOnly: true,
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'pkg-plasmid',
        packageRoot: '/lab/pAssembled',
      },
    });

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDisabled();
  });

  it('keeps Rename disabled for a loose sequence file', async () => {
    await renderForTab({
      id: 'tab-1',
      type: 'sequence',
      entityId: '/lab/plasmid.gb',
      label: 'plasmid.gb',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'ent-1' },
    });

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDisabled();
  });

  it('renames a matured plasmid by opening its metadata name for editing', async () => {
    const onStartRename = vi.fn();
    const onSelectTab = vi.fn();
    const onRenameManagedSequence = vi.fn();
    await renderForTab(
      {
        id: 'tab-1',
        type: 'sequence',
        entityId: 'pkg-plasmid',
        label: 'pAssembled',
        sequenceDocument: {
          kind: 'managed-sequence',
          packageId: 'pkg-plasmid',
          packageRoot: '/lab/pAssembled',
        },
      },
      { onStartRename, onSelectTab, onRenameManagedSequence }
    );

    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    expect(rename).toBeEnabled();
    fireEvent.click(rename);

    expect(onStartRename).not.toHaveBeenCalled();
    expect(onSelectTab).toHaveBeenCalledWith('tab-1');
    expect(onRenameManagedSequence).toHaveBeenCalledWith('tab-1');
  });
});
