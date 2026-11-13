import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackViewLibraryEntries, useIsTrackViewLibrary } from './TrackViewLibraryEntries';
import { trackViewFixture } from '../shared/track-view-fixture';

const bridge = vi.hoisted(() => ({ list: vi.fn(), locations: vi.fn() }));
vi.mock('../platform', () => ({ platform: () => ({ trackViews: bridge }) }));
vi.mock('../features/sequence/track-view-library', () => ({
  TRACK_VIEW_LIBRARY_CHANGED: 'dnaforge:track-view-library-changed',
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('saved Track view sidebar', () => {
  it('opens pointer-backed views by their real name and canonical file, without exposing index files', async () => {
    const path = '/projects/research/My genes.dnaforge-track-view.json';
    const document = { ...trackViewFixture(), name: 'My genes' };
    bridge.list.mockResolvedValue({
      views: [{ document, path, revision: 'a'.repeat(64) }],
      errors: [],
    });
    const open = vi.fn();
    const { container } = render(
      <TrackViewLibraryEntries onOpenView={open} activePath={path} refreshToken="1" />
    );
    const entry = await screen.findByRole('treeitem', { name: 'My genes' });
    expect(entry).toHaveAttribute('aria-selected', 'true');
    expect(entry.querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toContain('.location.json');
    fireEvent.click(entry);
    expect(open).toHaveBeenCalledWith(path);
  });

  it('uses the owned library directory, never another folder with the same display name', async () => {
    bridge.locations.mockResolvedValue({ defaultDirectory: '/profile/Track views' });
    function Folder({ path }: { path: string }) {
      return <span>{useIsTrackViewLibrary(path) ? 'library' : 'filesystem'}</span>;
    }
    const { rerender } = render(<Folder path="/projects/Track views" />);
    expect(await screen.findByText('filesystem')).toBeTruthy();
    rerender(<Folder path="/profile/Track views" />);
    expect(await screen.findByText('library')).toBeTruthy();
  });

  it('keeps healthy views available when another saved location is missing, and can retry', async () => {
    bridge.list
      .mockResolvedValueOnce({
        views: [{ document: trackViewFixture(), path: '/project/View.dnaforge-track-view.json' }],
        errors: [{ name: 'lost.location.json', message: 'ENOENT' }],
      })
      .mockResolvedValue({ views: [], errors: [] });
    render(<TrackViewLibraryEntries onOpenView={vi.fn()} activePath={null} refreshToken="1" />);
    expect(await screen.findByRole('treeitem')).toBeTruthy();
    expect(await screen.findByRole('alert')).toHaveTextContent('files have been preserved');
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved views' }));
    expect(await screen.findByText('No saved Track views.')).toBeTruthy();
  });
});
