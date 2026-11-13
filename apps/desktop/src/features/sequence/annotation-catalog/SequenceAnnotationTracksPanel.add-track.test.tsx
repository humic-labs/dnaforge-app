import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assemblyAccession } from '@waypoint/genome-data/annotation-catalog';

import { useCanvasStore } from '../../canvas/public/store';
import { inspectSequenceAnnotationTracks } from './annotation-catalog-commands';
import { loadAnnotationCatalogs } from './annotation-catalog-registry';
import { publishAnnotationCatalogWiring } from './annotation-catalog-wiring-status';
import { SequenceAnnotationTracksPanel, addableTracks } from './SequenceAnnotationTracksPanel';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';

const DOCUMENT_ID = 'fixture:sequence:mg1655-add-track';

beforeAll(async () => {
  await loadAnnotationCatalogs(bundledStoreBridge());
});

beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
});

function openTabWithCatalog(): string {
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: DOCUMENT_ID,
    label: 'MG1655',
    sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
  });
  publishAnnotationCatalogWiring(tabId, {
    assembly: { accession: assemblyAccession('NC_000913.3'), lengthBp: 4_641_652 },
    displayName: 'E. coli K-12 MG1655',
    drawing: { phase: 'waiting-for-map' },
    tracks: new Map(),
    hoverTracks: [],
  });
  return tabId;
}

function inspected(tabId: string) {
  const inspection = inspectSequenceAnnotationTracks(tabId);
  if (inspection.status !== 'found') throw new Error('tab should be found');
  return inspection;
}

describe('adding tracks: pick the track, then how to draw it', () => {
  it('offers every available source once per kind it provides, and none that is unavailable', () => {
    const tabId = openTabWithCatalog();
    const options = addableTracks(inspected(tabId).choices);
    expect(options.map((option) => option.key)).toContain('terminator|termite-ecoli-terminators');
    expect(options.map((option) => option.key)).toContain('tss|yan2018-tss');
    expect(options.map((option) => option.key)).toContain('promoter|promoter-windows-yan2018-tss');
    expect(options.some((option) => option.sourceId === 'ecocyc-open-database')).toBe(false);
    expect(
      options.find((option) => option.key === 'terminator|termite-ecoli-terminators')?.label
    ).toBe('Intrinsic terminators with measured RNA ends (TERMITe, Kosiński 2025) — Terminators');
  });

  it('adds the same track twice with two drawing styles, as two rows sharing one source', () => {
    const tabId = openTabWithCatalog();
    render(<SequenceAnnotationTracksPanel ownerTabId={tabId} mapCircular={false} />);

    const trackSelect = screen.getByLabelText('Track to add') as HTMLSelectElement;
    const styleSelect = screen.getByLabelText(
      'Drawing style for the new track'
    ) as HTMLSelectElement;
    act(() => {
      fireEvent.change(trackSelect, { target: { value: 'terminator|termite-ecoli-terminators' } });
    });
    const styles = Array.from(styleSelect.options).map((option) => option.value);
    expect(styles.length).toBeGreaterThan(1);

    act(() => {
      fireEvent.change(styleSelect, { target: { value: styles[0] } });
      fireEvent.click(screen.getByRole('button', { name: 'Add track' }));
    });
    act(() => {
      fireEvent.change(styleSelect, { target: { value: styles[1] } });
      fireEvent.click(screen.getByRole('button', { name: 'Add track' }));
    });

    const { tracks } = inspected(tabId);
    expect(tracks.map((track) => [track.binding.sourceId, track.binding.visualizationId])).toEqual([
      ['termite-ecoli-terminators', styles[0]],
      ['termite-ecoli-terminators', styles[1]],
    ]);
    expect(new Set(tracks.map((track) => track.binding.id)).size).toBe(2);
    expect(screen.getAllByTestId('annotation-track-row')).toHaveLength(2);
  });
});
