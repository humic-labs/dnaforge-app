import { useLayoutEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { ReadTrackGutter } from './ReadTrackGutter';
import {
  createReadTrackBindingFactory,
  editReadTrackLayout,
  resolveReadTrackLayout,
} from './read-track-presentation';
import type { SharedSangerLane } from './shared-sequence-read-model';

afterEach(cleanup);

function read(id: string, label: string): SharedSangerLane {
  return {
    id,
    label,
    kind: 'sanger',
    sequence: 'A',
    baseToColumn: [0],
    mutationColumns: [],
    deletionColumns: [],
    trace: {
      channels: { A: [2], C: [0], G: [0], T: [0] },
      maxValue: 2,
      peakPositions: [0],
      baseOrder: 'ACGT',
    },
  };
}

const lanes = [read('sanger-direct-current', 'Source'), read('sanger-attached-read', 'Attached')];
const layout = resolveReadTrackLayout(lanes, undefined, {
  'sanger-direct': 2,
  'sanger-attached-read': 4,
});
const bindings = createReadTrackBindingFactory()(lanes, 'ref', layout);

function setupMap() {
  let top = 200;
  const listeners = new Set<() => void>();
  const map = {
    getLinearRenderer: () => ({
      getLaneScreenSnapshot: () => ({
        overlayLayout: { offset: 0, totalHeight: 48 },
        trackScreenBounds: {
          'sanger-direct-current': { topPx: 48, heightPx: 138 },
          'sanger-attached-read': { topPx: top, heightPx: 138 },
        },
      }),
      getPresentedTrackScrollReceipt: () => ({ completedFrameEpoch: 1, trackScrollTop: 0 }),
    }),
    subscribeToPresentedFrames: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    requestRender: vi.fn(),
    setTrackStackEndReserve: vi.fn(),
  } as unknown as IndexedGenomeTileNativeMapHandle;
  return {
    map,
    move(next: number) {
      top = next;
      for (const cb of listeners) cb();
    },
  };
}

it('positions the gain control on its rendered track and changes only that read', () => {
  const { map, move } = setupMap();
  const update = vi.fn();
  render(
    <ReadTrackGutter
      mapRef={{ current: map }}
      referenceLabel="Reference"
      rendererEpoch={1}
      bindings={bindings}
      layout={layout}
      onCommand={update}
    />
  );
  const attached = screen.getByRole('slider', { name: 'Trace gain for Attached' });
  expect(attached).toHaveAttribute('aria-valuetext', '4×');
  const row = attached.closest('[data-track-gutter-row]');
  expect(row).toHaveStyle({ top: '200px' });
  act(() => move(140));
  expect(row).toHaveStyle({ top: '140px' });
  fireEvent.change(attached, { target: { value: '3' } });
  expect(update).toHaveBeenLastCalledWith({
    type: 'setting',
    id: 'sanger-attached-read',
    key: 'gain',
    value: 8,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reset gain for Attached' }));
  expect(update).toHaveBeenLastCalledWith({
    type: 'setting',
    id: 'sanger-attached-read',
    key: 'gain',
    value: 1,
  });
  expect(screen.getByRole('slider', { name: 'Trace gain for Source' })).toHaveAttribute(
    'aria-valuetext',
    '2×'
  );
});

it('attaches to the renderer mounted by the adjacent canvas', () => {
  const { map } = setupMap();
  function Canvas({ mapRef }: { mapRef: { current: IndexedGenomeTileNativeMapHandle | null } }) {
    useLayoutEffect(() => {
      mapRef.current = map;
    }, [mapRef]);
    return <canvas />;
  }
  function Viewer() {
    const mapRef = useRef<IndexedGenomeTileNativeMapHandle | null>(null);
    return (
      <>
        <ReadTrackGutter
          mapRef={mapRef}
          rendererEpoch={1}
          referenceLabel="Reference"
          bindings={bindings}
          layout={layout}
          onCommand={() => {}}
        />
        <Canvas mapRef={mapRef} />
      </>
    );
  }
  render(<Viewer />);
  expect(
    screen.getByRole('slider', { name: 'Trace gain for Source' }).closest('[data-track-gutter-row]')
  ).toHaveStyle({ top: '48px' });
});

it('moves a read into a named group using the shared settings popover', () => {
  const { map } = setupMap();
  const update = vi.fn();
  const grouped = editReadTrackLayout(layout, {
    type: 'create-group',
    id: 'set-a',
    label: 'Set A',
    trackIds: ['sanger-direct'],
  });
  render(
    <ReadTrackGutter
      mapRef={{ current: map }}
      referenceLabel="Reference"
      rendererEpoch={1}
      bindings={bindings}
      layout={grouped}
      onCommand={update}
    />
  );
  expect(screen.queryByRole('button', { name: 'Move Reference' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open settings for Attached' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Group for Attached' }));
  const destination = screen.getByRole('option', { name: 'Set A' });
  fireEvent.pointerDown(destination);
  fireEvent.click(destination);
  expect(update).toHaveBeenLastCalledWith({
    type: 'move',
    id: 'sanger-attached-read',
    groupId: 'set-a',
  });
});
