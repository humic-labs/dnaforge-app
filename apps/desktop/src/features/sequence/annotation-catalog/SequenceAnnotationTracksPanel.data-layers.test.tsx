import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';
import { useCanvasStore } from '../../canvas/public/store';
import type { SequenceDataLayerTrackControls } from '../data-layers/useSequenceDataLayers';
import { SequenceAnnotationTracksControl } from './SequenceAnnotationTracksPanel';

const layerId = `layer-${'a'.repeat(64)}`;

beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
});

function renderTracks(mapCircular = false, geometry: 'bars' | 'matrix' = 'bars') {
  const ownerTabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'ordinary-without-catalog',
    label: 'Existing sequence',
    sequenceDocument: {
      kind: 'import-source-sequence',
      documentId: 'ordinary-without-catalog',
      sourcePath: '/project/ordinary.gb',
    },
  });
  const dataLayers: SequenceDataLayerTrackControls = {
    rows: [
      {
        id: layerId,
        label: 'Fitness',
        visible: true,
        samples: [
          { id: 'first', label: 'First sample' },
          { id: 'second', label: 'Second sample' },
        ],
        unavailable: null,
        presentation: {
          sampleId: 'first',
          signalVisible: true,
          annotationColors: true,
          style: {
            geometry,
            colorScale: {
              kind: 'continuous',
              domain: [-2, 4],
              colors: [...SCIENTIFIC_COLOR_PALETTES.viridis.colors],
              missingColor: '#cccccc',
              transform: 'linear',
            },
          },
        },
      },
    ],
    errors: [],
    onVisibilityChange: vi.fn(),
    onPresentationChange: vi.fn(),
  };
  render(
    <SequenceAnnotationTracksControl
      ownerTabId={ownerTabId}
      mapCircular={mapCircular}
      dataLayers={dataLayers}
    />
  );
  return dataLayers;
}

describe('saved layers in the existing Tracks popover', () => {
  it('provides a native layer row without an annotation catalog or viewer strip', () => {
    const dataLayers = renderTracks();
    expect(screen.queryByLabelText('Show Fitness')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    expect(screen.getByLabelText('Show Fitness')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Show Fitness'));
    expect(dataLayers.onVisibilityChange).toHaveBeenCalledWith(layerId, false);
    expect(screen.queryByTestId('sequence-data-layers')).toBeNull();
    expect(screen.queryByTestId('sequence-data-layer-form')).toBeNull();
    expect(screen.queryByText('No annotation tracks for this sequence.')).toBeNull();
  });

  it('keeps the existing linear-map notice for saved layers without an annotation catalog', () => {
    renderTracks(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    expect(
      screen.getByText('These tracks draw on the linear map. Switch the map to linear to see them.')
    ).toBeVisible();
  });

  it('keeps sample, geometry and palette inside the layer gear settings', () => {
    const dataLayers = renderTracks();
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    expect(screen.queryByLabelText('Drawing style for Fitness')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings for Fitness' }));
    fireEvent.change(screen.getByLabelText('Drawing style for Fitness'), {
      target: { value: 'points' },
    });
    expect(dataLayers.onPresentationChange).toHaveBeenLastCalledWith(layerId, {
      ...dataLayers.rows[0].presentation,
      style: { ...dataLayers.rows[0].presentation.style, geometry: 'points' },
    });
    fireEvent.change(screen.getByLabelText('Drawing style for Fitness'), {
      target: { value: 'arcs' },
    });
    expect(dataLayers.onPresentationChange).toHaveBeenLastCalledWith(layerId, {
      ...dataLayers.rows[0].presentation,
      style: { ...dataLayers.rows[0].presentation.style, geometry: 'arcs' },
    });
    fireEvent.change(screen.getByLabelText('Sample for Fitness'), { target: { value: 'second' } });
    expect(dataLayers.onPresentationChange).toHaveBeenLastCalledWith(layerId, {
      ...dataLayers.rows[0].presentation,
      sampleId: 'second',
    });
    fireEvent.change(screen.getByLabelText('Color palette for Fitness'), {
      target: { value: 'cividis' },
    });
    expect(dataLayers.onPresentationChange).toHaveBeenLastCalledWith(layerId, {
      ...dataLayers.rows[0].presentation,
      style: {
        ...dataLayers.rows[0].presentation.style,
        colorScale: {
          ...dataLayers.rows[0].presentation.style.colorScale,
          colors: [...SCIENTIFIC_COLOR_PALETTES.cividis.colors],
        },
      },
    });
    expect(dataLayers.rows[0].presentation.style.geometry).toBe('bars');
  });

  it('shows every source sample in matrix mode and restores the remembered sample on a geometry change', () => {
    const dataLayers = renderTracks(false, 'matrix');
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings for Fitness' }));
    expect(screen.queryByLabelText('Sample for Fitness')).toBeNull();
    expect(screen.getByText('All 2 source samples')).toBeVisible();
    expect(screen.getByLabelText('Drawing style for Fitness')).toHaveValue('matrix');
    fireEvent.change(screen.getByLabelText('Drawing style for Fitness'), { target: { value: 'bars' } });
    expect(dataLayers.onPresentationChange).toHaveBeenLastCalledWith(layerId, {
      ...dataLayers.rows[0].presentation,
      sampleId: 'first',
      style: { ...dataLayers.rows[0].presentation.style, geometry: 'bars' },
    });
  });

  it('hides matrix annotation recoloring without clearing the retained preference', () => {
    const dataLayers = renderTracks(false, 'matrix');
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings for Fitness' }));
    expect(screen.queryByLabelText('Color annotations from Fitness')).toBeNull();
    fireEvent.change(screen.getByLabelText('Drawing style for Fitness'), { target: { value: 'bars' } });
    expect(dataLayers.onPresentationChange).toHaveBeenLastCalledWith(layerId, {
      ...dataLayers.rows[0].presentation,
      sampleId: 'first',
      annotationColors: true,
      style: { ...dataLayers.rows[0].presentation.style, geometry: 'bars' },
    });
  });
});
