// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { focusedPanelId: 'main', panels: {} } as any,
  listener: null as null | (() => void),
  byId: vi.fn(),
  byPath: vi.fn(),
}));
vi.mock('../features/canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => mocks.state,
    subscribe: (listener: () => void) => {
      mocks.listener = listener;
      return () => {
        mocks.listener = null;
      };
    },
  },
}));
vi.mock('../db/workspace-catalog', () => ({
  getCatalogEntity: mocks.byId,
  getCatalogEntityForFilePath: mocks.byPath,
}));
import { observeEntityViews } from './observe-entity-views';
import { useEntityViewHistory } from './recent-entity-views';

function activate(id: string, status = 'loaded') {
  mocks.state = {
    focusedPanelId: 'main',
    panels: { main: { activeTabId: id, tabs: [{ id, entityId: id, loadStatus: status }] } },
  };
  mocks.listener?.();
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
  mocks.listener = null;
  mocks.state = { focusedPanelId: 'main', panels: {} };
  mocks.byId.mockReset().mockImplementation(async (id: string) => ({ id, status: 'active' }));
  mocks.byPath.mockReset().mockResolvedValue(null);
  useEntityViewHistory.setState({ views: [] });
});

it('records a viewed canonical entity once, while editing the active tab does not refresh its viewing time', async () => {
  const stop = observeEntityViews();
  activate('alpha::sequence');
  await settle();
  const before = useEntityViewHistory.getState().views;
  mocks.state.panels.main.tabs[0].isDirty = true;
  mocks.listener?.();
  await settle();
  expect(useEntityViewHistory.getState().views).toEqual(before);
  expect(mocks.byId).toHaveBeenCalledTimes(1);
  stop();
});

it('waits for readable content and omits failed opens', async () => {
  const stop = observeEntityViews();
  activate('a', 'pending');
  await settle();
  activate('a', 'error');
  await settle();
  expect(useEntityViewHistory.getState().views).toEqual([]);
  activate('a');
  await settle();
  expect(useEntityViewHistory.getState().views[0].entityId).toBe('a');
  stop();
});

it('rejects an obsolete asynchronous observation after switching to another entity', async () => {
  let resolveA!: (value: { id: string; status: string }) => void;
  mocks.byId.mockImplementation((id: string) =>
    id === 'a'
      ? new Promise((resolve) => {
          resolveA = resolve;
        })
      : Promise.resolve({ id, status: 'active' })
  );
  const stop = observeEntityViews();
  activate('a');
  activate('b');
  await settle();
  resolveA({ id: 'a', status: 'active' });
  await settle();
  expect(useEntityViewHistory.getState().views.map((view) => view.entityId)).toEqual(['b']);
  stop();
});

it('resolves a file tab to its catalog identity and never records an archived entity', async () => {
  mocks.byId.mockResolvedValue(null);
  mocks.byPath.mockResolvedValue({ id: 'canonical-file', status: 'active' });
  const stop = observeEntityViews();
  activate('/project/a.txt');
  await settle();
  expect(useEntityViewHistory.getState().views[0].entityId).toBe('canonical-file');
  mocks.byPath.mockResolvedValue({ id: 'archived', status: 'archived' });
  activate('/project/b.txt');
  await settle();
  expect(useEntityViewHistory.getState().views).toHaveLength(1);
  stop();
});

it.each([
  {
    id: 'canonical-structure',
    view: { initialStructureAttrs: { structureArtifactRef: { entityId: 'canonical-structure' } } },
  },
  {
    id: 'project::canonical-molecular-document',
    path: '/project/view.dnaforge-molecular.json',
    view: {
      initialStructureAttrs: {
        molecularDocumentId: 'canonical-molecular-document',
        molecularDocumentPath: '/project/view.dnaforge-molecular.json',
        structureArtifactRef: { entityId: 'canonical-structure' },
      },
    },
  },
  {
    id: 'canonical-track-view',
    path: '/project/view.dnaforge-track-view.json',
    view: {
      trackView: {
        path: '/project/view.dnaforge-track-view.json',
        document: { id: 'canonical-track-view' },
      },
    },
  },
])('records the document identity behind a scientific view: $id', async ({ id, path, view }) => {
  if (path) mocks.byPath.mockResolvedValue({ id, status: 'active' });
  const stop = observeEntityViews();
  mocks.state = {
    focusedPanelId: 'main',
    panels: {
      main: {
        activeTabId: 'view',
        tabs: [{ id: 'view', entityId: 'rendered-view', loadStatus: 'loaded', ...view }],
      },
    },
  };
  mocks.listener?.();
  await settle();
  expect(useEntityViewHistory.getState().views[0].entityId).toBe(id);
  stop();
});
