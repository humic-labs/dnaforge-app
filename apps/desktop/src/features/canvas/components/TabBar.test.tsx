/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TabBar } from './TabBar';
import { MANAGED_SEQUENCE_RENAME_EVENT } from '../../sequence/public/managed-sequence-rename';

const canvasMocks = vi.hoisted(() => ({
  updateTab: vi.fn(),
  panels: {} as Record<string, { id: string; tabs: unknown[]; activeTabId: string | null }>,
}));
const pageMocks = vi.hoisted(() => ({
  renamePageArtifact: vi.fn(),
  pages: {} as Record<string, { content: unknown }>,
}));

vi.mock('../dragStore', () => ({
  useDragStore: (selector: (state: unknown) => unknown) =>
    selector({
      isDragging: false,
      dropTargetPanelId: null,
      dropInsertIndex: null,
      dragTabId: null,
      startDrag: vi.fn(),
    }),
}));

vi.mock('../store', () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({
      updateTab: canvasMocks.updateTab,
      panels: canvasMocks.panels,
      joinAllPanels: vi.fn(),
      mergePanels: vi.fn(),
      splitAndMoveTab: vi.fn(),
    }),
}));

vi.mock('../../page/store', () => ({
  usePageStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        renamePageArtifact: pageMocks.renamePageArtifact,
        pages: pageMocks.pages,
      }),
    {
      getState: () => ({
        renamePageArtifact: pageMocks.renamePageArtifact,
        pages: pageMocks.pages,
      }),
    }
  ),
}));

vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({ folders: [] }),
}));

vi.mock('../../../hooks/useGitStatus', () => ({
  useGitStatus: () => ({
    statusMap: new Map(),
  }),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  canvasMocks.panels = {};
  pageMocks.pages = {
    'page-1': {
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      title: 'Renamed Notebook',
    },
  };
  pageMocks.renamePageArtifact.mockResolvedValue({
    path: '/lab/Renamed Notebook',
    name: 'Renamed Notebook',
    fileKind: 'waypoint-notebook',
    sizeBytes: 42,
  });
});

describe('TabBar notebook rename', () => {
  it('renames the backing notebook artifact before updating the page tab label', async () => {
    const workspaceEvents: Array<{ path?: string }> = [];
    const handleWorkspaceFilesChanged = (event: Event) => {
      workspaceEvents.push((event as CustomEvent<{ path?: string }>).detail);
    };
    window.addEventListener('waypoint:workspace-files-changed', handleWorkspaceFilesChanged);

    render(
      <TabBar
        panelId="main"
        activeTabId="tab-1"
        tabs={[{ id: 'tab-1', type: 'page', entityId: 'page-1', label: 'Old Notebook' }]}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    fireEvent.doubleClick(screen.getByTestId('tab-tab-1'));
    const input = await screen.findByDisplayValue('Old Notebook');
    fireEvent.change(input, { target: { value: 'Renamed Notebook' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(pageMocks.renamePageArtifact).toHaveBeenCalledWith('page-1', 'Renamed Notebook');
      expect(canvasMocks.updateTab).toHaveBeenCalledWith('main', 'tab-1', {
        label: 'Renamed Notebook',
      });
    });
    expect(workspaceEvents).toContainEqual({ path: '/lab/Renamed Notebook' });

    window.removeEventListener('waypoint:workspace-files-changed', handleWorkspaceFilesChanged);
  });
});

describe('TabBar plasmid rename', () => {
  it('selects a matured plasmid and asks its metadata drawer to edit the name', () => {
    const onSelectTab = vi.fn();
    const requests: Array<{ packageId?: string }> = [];
    const capture = (event: Event) => {
      requests.push((event as CustomEvent<{ packageId?: string }>).detail);
    };
    window.addEventListener(MANAGED_SEQUENCE_RENAME_EVENT, capture);
    const tabs = [
      {
        id: 'tab-1',
        type: 'sequence' as const,
        entityId: 'pkg-plasmid',
        label: 'pAssembled',
        sequenceDocument: {
          kind: 'managed-sequence' as const,
          packageId: 'pkg-plasmid',
          packageRoot: '/lab/pAssembled',
        },
      },
    ];
    canvasMocks.panels = { main: { id: 'main', tabs, activeTabId: 'other' } };

    render(
      <TabBar
        panelId="main"
        activeTabId="other"
        tabs={tabs}
        onSelectTab={onSelectTab}
        onCloseTab={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByTestId('tab-tab-1'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(onSelectTab).toHaveBeenCalledWith('tab-1');
    expect(requests).toEqual([expect.objectContaining({ packageId: 'pkg-plasmid' })]);
    window.removeEventListener(MANAGED_SEQUENCE_RENAME_EVENT, capture);
  });
});
