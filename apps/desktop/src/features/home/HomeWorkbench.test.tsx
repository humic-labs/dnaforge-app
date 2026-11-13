import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HomeWorkbench } from './HomeWorkbench';
import {
  peekRecentlyEditedSnapshot,
  publishRecentlyEditedSnapshot,
  resetRecentlyEditedSnapshotForTests,
} from './recently-edited';

const mocks = vi.hoisted(() => ({
  refreshRecentlyEdited: vi.fn().mockResolvedValue([]),
}));

vi.mock('./recently-edited', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recently-edited')>();
  return {
    ...actual,
    refreshRecentlyEdited: mocks.refreshRecentlyEdited,
  };
});

vi.mock('../../components/HomePanel', () => ({
  HomePanel: ({ recentlyEditedReady = true }: { recentlyEditedReady?: boolean }) => {
    const items = recentlyEditedReady ? peekRecentlyEditedSnapshot() : [];
    return (
      <div data-testid="home-panel">
        {items.map((item) => (
          <div key={item.id}>{item.title}</div>
        ))}
      </div>
    );
  },
}));

const item = {
  id: 'page-1',
  title: 'Lab notes',
  workspaceRoot: '/ws/lab',
  workspaceName: 'Lab',
  updatedAt: 1000,
  open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
};

describe('HomeWorkbench', () => {
  beforeEach(() => {
    resetRecentlyEditedSnapshotForTests();
    mocks.refreshRecentlyEdited.mockReset().mockResolvedValue([]);
  });

  it('shows snapshot items after unmount/remount even when refresh never resolves ', () => {
    mocks.refreshRecentlyEdited.mockImplementation(() => new Promise(() => {}));
    publishRecentlyEditedSnapshot([item]);
    const { unmount } = render(<HomeWorkbench mode="files-empty" recentlyEditedReady />);
    expect(screen.getByText('Lab notes')).toBeInTheDocument();
    unmount();
    expect(peekRecentlyEditedSnapshot()).toEqual([item]);

    render(<HomeWorkbench mode="home" recentlyEditedReady />);
    expect(screen.getByText('Lab notes')).toBeInTheDocument();
  });

  it('does not expose a stale snapshot while workspace access is still registering ', () => {
    publishRecentlyEditedSnapshot([item]);
    const view = render(<HomeWorkbench mode="home" recentlyEditedReady={false} />);

    expect(screen.queryByText('Lab notes')).not.toBeInTheDocument();
    expect(mocks.refreshRecentlyEdited).not.toHaveBeenCalled();

    view.rerender(<HomeWorkbench mode="home" recentlyEditedReady />);
    expect(screen.getByText('Lab notes')).toBeInTheDocument();
    expect(mocks.refreshRecentlyEdited).toHaveBeenCalledWith(50);
  });
});
