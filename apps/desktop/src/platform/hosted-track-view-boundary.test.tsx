import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userMessage } from '@waypoint/user-messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TrackViewLibraryEntries,
  useIsTrackViewLibrary,
} from '../components/TrackViewLibraryEntries';
import { trackViewFixture } from '../shared/track-view-fixture';
import { hostedBrowserBridge } from './hosted';

vi.mock('../platform', () => ({ platform: () => hostedBrowserBridge }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('hosted Track view asynchronous boundary', () => {
  const calls = [
    { method: 'locations', call: () => hostedBrowserBridge.trackViews.locations() },
    { method: 'list', call: () => hostedBrowserBridge.trackViews.list() },
    { method: 'read', call: () => hostedBrowserBridge.trackViews.read('saved-view') },
    {
      method: 'save',
      call: () =>
        hostedBrowserBridge.trackViews.save({
          document: trackViewFixture(),
          expectedRevision: null,
        }),
    },
    {
      method: 'command',
      call: () => hostedBrowserBridge.trackViews.command({ operation: 'references' }),
    },
  ];

  it.each(calls)('rejects $method through its promised result', async ({ method, call }) => {
    await expect(call()).rejects.toMatchObject({
      code: 'HOSTED_CAPABILITY_UNAVAILABLE',
      diagnosticCapability: `platform.trackViews.${method}`,
      message: userMessage('tracks.unavailable'),
    });
  });

  it('keeps an ordinary project folder mounted when the native library is unavailable', async () => {
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    function ProjectFolder() {
      const library = useIsTrackViewLibrary('/hosted/11111111-1111-4111-8111-111111111111');
      return <div>{library ? 'Saved views' : 'Project files'}</div>;
    }
    expect(() => render(<ProjectFolder />)).not.toThrow();
    await waitFor(() => expect(diagnostic).toHaveBeenCalled());
    expect(screen.getByText('Project files')).toBeVisible();
    expect(screen.queryByText(/platform\.trackViews|HostedCapabilityError/u)).toBeNull();
  });

  it('settles the shared library component through its existing retry state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() =>
      render(<TrackViewLibraryEntries activePath={null} onOpenView={vi.fn()} refreshToken="1" />)
    ).not.toThrow();
    expect(await screen.findByRole('alert')).toHaveTextContent('files have been preserved');
    expect(screen.getByRole('button', { name: 'Retry saved views' })).toBeEnabled();
    expect(screen.queryByText(/platform\.trackViews|HostedCapabilityError/u)).toBeNull();
  });
});
