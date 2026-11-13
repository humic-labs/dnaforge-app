import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { usePostUpdateToast } from '../../../hooks/usePostUpdateToast';

const { open, postUpdate } = vi.hoisted(() => ({ open: vi.fn(), postUpdate: vi.fn() }));
vi.mock('../../../hooks/useReleaseNotesPresentation', () => ({
  useReleaseNotesPresentation: () => ({ open, modalProps: { open: false } }),
}));
vi.mock('../../../hooks/usePostUpdateToast', () => ({ usePostUpdateToast: postUpdate }));
vi.mock('../../../components/ReleaseNotesModal', () => ({ ReleaseNotesModal: () => null }));

import {
  openReleaseNotes,
  RendererFeatureActivations,
  RENDERER_FEATURES,
} from '../../../feature-registry';

describe('registered release-note presentation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes shell requests with their opener and removes the listener on unmount', () => {
    const opener = document.createElement('button');
    const { unmount } = render(
      <RendererFeatureActivations
        openView={vi.fn()}
        features={RENDERER_FEATURES.filter(({ id }) => id === 'release-notes')}
      />
    );
    act(() => openReleaseNotes('settings', undefined, opener));
    act(() => openReleaseNotes('home', undefined, opener));
    expect(open.mock.calls).toEqual([
      ['settings', undefined, opener],
      ['home', undefined, opener],
    ]);
    unmount();
    openReleaseNotes('home', undefined, opener);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('routes post-update toast requests through the same presentation owner', () => {
    render(
      <RendererFeatureActivations
        openView={vi.fn()}
        features={RENDERER_FEATURES.filter(({ id }) => id === 'release-notes')}
      />
    );
    const onView: Parameters<typeof usePostUpdateToast>[0] = postUpdate.mock.calls[0][0];
    const opener = document.createElement('button');
    act(() => onView('0.8.10', opener));
    expect(open).toHaveBeenCalledWith('post_update_toast', '0.8.10', opener);
  });
});
