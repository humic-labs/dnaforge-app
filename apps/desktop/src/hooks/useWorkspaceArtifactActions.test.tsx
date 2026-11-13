import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => {
  const canvas = { openInFocusedPanel: vi.fn(), unrelated: 'canvas' };
  const page = { createPage: vi.fn(), unrelated: 'page' };
  const design = {
    createDesign: vi.fn(() => 'design-1'),
    createDraftDesign: vi.fn(() => 'draft-1'),
    designs: {} as Record<string, unknown>,
    unrelated: 'design',
  };
  const selectors: Array<{ store: string; selector: (state: never) => unknown }> = [];
  const hook = <State,>(store: string, state: State) =>
    Object.assign(
      (selector: (value: State) => unknown) => {
        selectors.push({ store, selector: selector as (state: never) => unknown });
        return selector(state);
      },
      { getState: () => state }
    );
  return {
    canvas,
    page,
    design,
    selectors,
    useCanvasStore: hook('canvas', canvas),
    usePageStore: hook('page', page),
    useDesignStore: hook('design', design),
  };
});
const notebook = vi.hoisted(() => ({ createWorkspaceNotebook: vi.fn() }));

vi.mock('../features/canvas', () => ({ useCanvasStore: stores.useCanvasStore }));
vi.mock('../features/page', () => ({ usePageStore: stores.usePageStore }));
vi.mock('../features/design', () => ({ useDesignStore: stores.useDesignStore }));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ bumpFileTreeRefresh: vi.fn(), revealPath: vi.fn() }) },
}));
vi.mock('../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));
vi.mock('../features/page/public/create-notebook-command', () => notebook);
vi.mock('../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: async (_root: string, run: (token: string) => Promise<unknown>) =>
    run('mutation-token'),
}));
vi.mock('../db/workspace-catalog', () => ({
  registerContextualCatalogEntity: vi.fn(async () => ({ id: 'entity-1' })),
}));
vi.mock('../db/workspace-artifacts', () => ({
  createDesignArtifactFile: vi.fn(async () => null),
}));

import { useWorkspaceArtifactActions } from './useWorkspaceArtifactActions';

function renderActions(folders: Parameters<typeof useWorkspaceArtifactActions>[0]['folders'] = []) {
  return renderHook(() =>
    useWorkspaceArtifactActions({
      folders,
      setCreateDestinationRequest: vi.fn(),
      reconcileChangedWorkspace: vi.fn(async () => undefined),
      handleCreateEntity: vi.fn(async () => undefined),
      handleViewChange: vi.fn(),
      workspaceRootFromCreationContext: () => '/project',
      artifactTitleFromCreationContext: (_context, _noun, fallback) => fallback,
    })
  ).result.current;
}

describe('useWorkspaceArtifactActions store reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stores.selectors.length = 0;
  });

  it('subscribes to exactly the four store fields it uses', () => {
    renderActions();
    expect(
      stores.selectors.map(({ store, selector }) => [
        store,
        selector(
          (store === 'canvas'
            ? stores.canvas
            : store === 'page'
              ? stores.page
              : stores.design) as never
        ),
      ])
    ).toEqual([
      ['canvas', stores.canvas.openInFocusedPanel],
      ['page', stores.page.createPage],
      ['design', stores.design.createDesign],
      ['design', stores.design.createDraftDesign],
    ]);
  });

  it('creates a notebook with the page store and opens it through the canvas store', async () => {
    notebook.createWorkspaceNotebook.mockImplementation(
      async ({ onCreated }: { onCreated: (pageId: string) => void }) => {
        onCreated('page-1');
        return { artifact: null };
      }
    );
    await renderActions().handleNewPage();
    expect(notebook.createWorkspaceNotebook).toHaveBeenCalledWith(
      expect.objectContaining({ createPage: stores.page.createPage, workspaceRoot: '/project' })
    );
    expect(stores.canvas.openInFocusedPanel).toHaveBeenCalledWith('page', 'page-1', 'Untitled');
  });

  it('creates a design with the design store and opens it through the canvas store', async () => {
    await renderActions().handleNewDesign();
    expect(stores.design.createDesign).toHaveBeenCalledWith('Untitled');
    expect(stores.canvas.openInFocusedPanel).toHaveBeenCalledWith('design', 'design-1', 'Untitled');
  });

  it('opens an assembly draft from the design store through the canvas store', () => {
    renderActions([{ path: '/project', name: 'project', addedAt: 0 }]).handleCreateAssembly({
      destinationPath: '/project/assemblies',
      mode: 'blank',
    });
    expect(stores.design.createDraftDesign).toHaveBeenCalledWith('Untitled Assembly', 'gibson');
    expect(stores.canvas.openInFocusedPanel).toHaveBeenCalledWith(
      'design',
      'draft-1',
      'Untitled Assembly',
      {
        artifactDocument: {
          kind: 'assembly',
          persistence: 'draft',
          workspaceRoot: '/project',
          destinationPath: '/project/assemblies',
        },
      }
    );
  });
});
