import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LimsEntity } from '../../../shared/lims';
import { LIMS_ENTITY_QUERY_HARD_MAX } from '../../../shared/lims-registry';

const { queryEntities, readTrackView } = vi.hoisted(() => ({
  queryEntities: vi.fn(),
  readTrackView: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    lims: { queryEntities },
    trackViews: { read: readTrackView },
  }),
}));

import { emitRegistryChanged, OPEN_REGISTRY_EVENT } from '../../../shared/registry-events';
import { ReferenceSavedViewMenu } from './ReferenceSavedViewMenu';

function view(
  id: string,
  name: string,
  referenceAssemblyId: string,
  updatedAt: number
): LimsEntity {
  return {
    id,
    kind: 'track-view',
    name,
    fields: { referenceAssemblyId, trackCount: 2 },
    updatedAt,
    tombstone: false,
  } as LimsEntity;
}

describe('reference details saved views', () => {
  beforeEach(() => {
    queryEntities.mockReset();
    readTrackView.mockReset();
  });
  afterEach(cleanup);

  it('shows matching Registry entities in recent order and opens their saved files', async () => {
    const older = view('track-view-older-1234', 'Older view', 'ce11', 10);
    const newer = view('track-view-newer-1234', 'Newer view', 'WBcel235', 20);
    const unrelated = view('track-view-other-1234', 'Other view', 'grch38', 30);
    queryEntities.mockResolvedValue([older, newer, unrelated]);
    readTrackView.mockResolvedValue({ path: '/project/Newer view.dnaforge-track-view.json' });
    const onOpenView = vi.fn();
    const registryOpen = vi.fn();
    window.addEventListener(OPEN_REGISTRY_EVENT, registryOpen);
    try {
      render(
        <ReferenceSavedViewMenu
          referenceId="ce11"
          referenceKeys={['ce11', 'WBcel235']}
          onOpenView={onOpenView}
        />
      );
      await screen.findByText('Newer view');
      expect(screen.getByText('Saved views')).toBeVisible();
      expect(screen.queryByText('Saved views in Registry')).toBeNull();
      expect(queryEntities).toHaveBeenCalledOnce();
      expect(queryEntities).toHaveBeenCalledWith({
        kind: 'track-view',
        limit: LIMS_ENTITY_QUERY_HARD_MAX,
      });
      expect(screen.getAllByTestId(/^reference-saved-view-/u)).toHaveLength(2);
      const rows = screen.getByTestId('reference-saved-views-ce11');
      expect(rows).not.toHaveTextContent('Other view');
      expect(rows.textContent?.indexOf('Newer view')).toBeLessThan(
        rows.textContent?.indexOf('Older view') ?? 0
      );
      fireEvent.click(screen.getByTestId('reference-saved-view-track-view-newer-1234'));
      await waitFor(() =>
        expect(onOpenView).toHaveBeenCalledWith('/project/Newer view.dnaforge-track-view.json')
      );
      expect(readTrackView).toHaveBeenCalledWith('track-view-newer-1234');
      fireEvent.click(screen.getByRole('button', { name: 'Details for Newer view' }));
      expect(registryOpen).toHaveBeenCalledOnce();
      expect((registryOpen.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        entityId: 'track-view-newer-1234',
        fallbackSearch: 'track-view',
      });
    } finally {
      window.removeEventListener(OPEN_REGISTRY_EVENT, registryOpen);
    }
  });

  it('refreshes from the Registry after a saved file is projected', async () => {
    let resolveInitial!: (entities: LimsEntity[]) => void;
    queryEntities
      .mockReturnValueOnce(new Promise<LimsEntity[]>((resolve) => (resolveInitial = resolve)))
      .mockResolvedValueOnce([view('track-view-fresh-1234', 'Fresh view', 'ce11', 30)]);
    render(
      <ReferenceSavedViewMenu
        referenceId="ce11"
        referenceKeys={['ce11']}
        onOpenView={() => undefined}
      />
    );
    const details = screen.getByTestId('reference-saved-views-ce11');
    expect(details).not.toHaveTextContent('Loading saved views');
    await act(async () => resolveInitial([]));
    expect(details).not.toHaveTextContent('Saved views');
    expect(details).not.toHaveTextContent('No saved views for this reference');
    act(() => emitRegistryChanged());
    await screen.findByText('Fresh view');
    expect(screen.getByText('Saved views')).toBeVisible();
  });
});
