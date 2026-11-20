/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TabBar } from './TabBar';
import { useDragStore } from '../dragStore';
import { MANAGED_SEQUENCE_RENAME_EVENT } from '../../sequence/public/managed-sequence-rename';

const canvasMocks = vi.hoisted(() => ({
  updateTab: vi.fn(),
  panels: {} as Record<string, { id: string; tabs: unknown[]; activeTabId: string | null }>,
}));
const pageMocks = vi.hoisted(() => ({
  renamePageArtifact: vi.fn(),
  pages: {} as Record<string, { content: unknown }>,
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
  useDragStore.getState().endDrag();
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

it.each([
  ['main', 1, 0],
  ['main', 2, 0],
  ['main', 0, 1],
  ['main', 3, 1],
  ['other', 2, 1],
] as const)(
  'shows the insertion line only for a move from %s to boundary %i',
  (source, boundary, count) => {
    const tabs = ['A', 'B', 'C'].map((id) => ({
      id,
      type: 'text' as const,
      entityId: id,
      label: id,
    }));
    const drag = useDragStore.getState();
    drag.startDrag(source === 'main' ? 'B' : 'D', source, 'Document', 'text');
    drag.setDropTarget('main', boundary);
    const { container } = render(
      <TabBar
        tabs={tabs}
        panelId="main"
        activeTabId="B"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );
    expect(container.querySelectorAll('[role="tab"] > .bg-accent')).toHaveLength(count);
  }
);
