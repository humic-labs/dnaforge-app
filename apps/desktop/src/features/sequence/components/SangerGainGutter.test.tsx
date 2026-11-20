import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { SangerGainGutter } from './SangerGainGutter';
import type { SharedSangerLane } from './shared-sequence-read-model';

it('positions independent gain controls at their rendered lanes and restores the selected read alone', () => {
  const lanes = [
    { id: 'sanger-direct-current', label: 'Source' },
    { id: 'sanger-attached-read', label: 'Attached' },
  ] as SharedSangerLane[];
  let top = 200;
  const map = {
    getLinearRenderer: () => ({
      getLaneScreenSnapshot: () => ({
        trackScreenBounds: {
          'sanger-direct-current': { topPx: top - 138, heightPx: 138 },
          'sanger-attached-read': { topPx: top, heightPx: 138 },
        },
      }),
      getPresentedTrackScrollReceipt: () => ({ contentClipTopPx: 18 }),
    }),
    subscribeToPresentedFrames: vi.fn((_presented: () => void) => vi.fn()),
  };
  const update = vi.fn();
  render(
    <SangerGainGutter
      mapRef={{ current: map as unknown as IndexedGenomeTileNativeMapHandle }}
      lanes={lanes}
      gains={{ 'sanger-direct': 2, 'sanger-attached-read': 4 }}
      onGainChange={update}
      rendererEpoch={1}
    />
  );
  const attached = screen.getByRole('slider', { name: 'Trace gain for Attached' });
  expect(attached.getAttribute('aria-valuetext')).toBe('4×');
  expect(attached.parentElement?.style.top).toBe('200px');
  top = 140;
  map.subscribeToPresentedFrames.mock.calls[0]![0]();
  expect(attached.parentElement?.style.top).toBe('140px');
  fireEvent.change(attached, { target: { value: '3' } });
  expect(update).toHaveBeenLastCalledWith(lanes[1], 8);
  fireEvent.click(screen.getByRole('button', { name: 'Reset gain for Attached' }));
  expect(update).toHaveBeenLastCalledWith(lanes[1], 1);
  expect(
    screen.getByRole('slider', { name: 'Trace gain for Source' }).getAttribute('aria-valuetext')
  ).toBe('2×');
});
