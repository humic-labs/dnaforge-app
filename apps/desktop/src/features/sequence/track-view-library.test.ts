import { describe, expect, it, vi } from 'vitest';
import type { SavedTrackView } from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';

const mocks = vi.hoisted(() => ({
  writeProjection: vi.fn(),
}));

vi.mock('../../db/entity-substrate/track-view-adapter', () => ({
  trackViewAdapter: { writeProjection: mocks.writeProjection },
}));

import { projectSavedTrackView } from './track-view-library';

describe('Track view Registry projection scheduling', () => {
  it('coalesces simultaneous projection requests for the same saved file', async () => {
    let finishProjection: (() => void) | undefined;
    mocks.writeProjection.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishProjection = resolve;
        })
    );
    const saved: SavedTrackView = {
      document: trackViewFixture(),
      path: '/profile/Track views/Genes.dnaforge-track-view.json',
      workspaceRoot: null,
    };

    const first = projectSavedTrackView(saved);
    const second = projectSavedTrackView(saved);

    expect(mocks.writeProjection).toHaveBeenCalledOnce();
    finishProjection?.();
    await Promise.all([first, second]);

    mocks.writeProjection.mockResolvedValueOnce(undefined);
    await projectSavedTrackView(saved);
    expect(mocks.writeProjection).toHaveBeenCalledTimes(2);
  });
});
