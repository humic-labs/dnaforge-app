import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userMessage } from '@waypoint/user-messages';
import { listSavedTrackViews } from '../track-view-library';
import { SavedTrackViews } from './SavedTrackViews';

vi.mock('../track-view-library', () => ({
  listSavedTrackViews: vi.fn(),
  TRACK_VIEW_LIBRARY_CHANGED: 'dnaforge:track-view-library-changed',
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('saved reference views public failures', () => {
  it('keeps the reported unsupported platform method out of the reference tool', async () => {
    vi.mocked(listSavedTrackViews).mockRejectedValue(
      new Error('platform.trackViews.list is not available in the hosted browser runtime.')
    );
    render(<SavedTrackViews filter="" onOpenView={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('tracks.loadFailed'));
    expect(screen.queryByText(/platform\.trackViews|hosted browser runtime/u)).toBeNull();
  });

  it('keeps saved-view diagnostics out of the public error rows', async () => {
    vi.mocked(listSavedTrackViews).mockResolvedValue({
      views: [],
      errors: [{ name: 'platform.trackViews.list', message: 'VITE_API_URL is not set' }],
    });
    render(<SavedTrackViews filter="" onOpenView={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('tracks.loadFailed'));
    expect(screen.queryByText(/platform\.trackViews|VITE_API_URL/u)).toBeNull();
  });
});
