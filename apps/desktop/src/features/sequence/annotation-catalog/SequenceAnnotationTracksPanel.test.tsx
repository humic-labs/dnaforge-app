import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAnnotationCatalogs } from './annotation-catalog-registry';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';

beforeAll(async () => {
  await loadAnnotationCatalogs(bundledStoreBridge());
});

import { assemblyAccession, trackBindingId } from '@waypoint/genome-data/annotation-catalog';

import { useCanvasStore } from '../../canvas/public/store';
import {
  inspectSequenceAnnotationTracks,
  subscribeSequenceAnnotationTracks,
  updateSequenceAnnotationTracks,
} from './annotation-catalog-commands';
import {
  publishAnnotationCatalogWiring,
  readAnnotationCatalogWiring,
} from './annotation-catalog-wiring-status';
import { friendlyLicenseName } from './license-names';
import { SequenceAnnotationTracksPanel } from './SequenceAnnotationTracksPanel';

const DOCUMENT_ID = 'fixture:sequence:mg1655-panel';

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

beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
});

describe('SequenceAnnotationTracksPanel', () => {
  it('offers the default tracks, then lists them with sources, styles, and attribution', () => {
    const tabId = openTabWithCatalog();
    render(<SequenceAnnotationTracksPanel ownerTabId={tabId} mapCircular={false} />);

    expect(screen.getByText('No tracks yet.')).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Use default tracks' }));
    });

    const inspection = inspectSequenceAnnotationTracks(tabId);
    if (inspection.status !== 'found') throw new Error('tab should be found');
    expect(screen.getAllByTestId('annotation-track-row')).toHaveLength(inspection.tracks.length);

    const terminatorSource = screen.getByLabelText('Terminators source') as HTMLSelectElement;
    const ecocyc = Array.from(terminatorSource.options).find(
      (option) => option.value === 'ecocyc-open-database'
    );
    expect(ecocyc?.disabled).toBe(true);
    expect(screen.getAllByText(/Why is EcoCyc not available\?/).length).toBeGreaterThan(0);

    const terminators = inspection.tracks.find((track) => track.binding.kind === 'terminator');
    if (terminators?.source) {
      expect(
        screen.getByText(terminators.source.license.attribution, { exact: false })
      ).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Copy track settings' })).toBeTruthy();
  });

  it('names licenses in plain words and keeps loader details in a tooltip', () => {
    const tabId = openTabWithCatalog();
    render(<SequenceAnnotationTracksPanel ownerTabId={tabId} mapCircular={false} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Use default tracks' }));
    });
    const wiring = readAnnotationCatalogWiring(tabId);
    if (!wiring) throw new Error('wiring should be published');
    act(() => {
      publishAnnotationCatalogWiring(tabId, {
        ...wiring,
        drawing: { phase: 'active' },
        tracks: new Map([
          [
            trackBindingId('terminators'),
            {
              status: 'error',
              message: "Couldn't load this source.",
              detail: 'coordinates [5, 3) outside 0..4641652',
            },
          ],
          [
            trackBindingId('transcription-units'),
            { status: 'ready', recordCount: 120, totalBeforeFilter: 666 },
          ],
        ]),
      });
    });

    const rowFor = (id: string) => {
      const row = screen
        .getAllByTestId('annotation-track-row')
        .find((element) => element.getAttribute('data-track-id') === id);
      if (!row) throw new Error(`no row for ${id}`);
      return row;
    };
    const statusOf = (id: string) =>
      rowFor(id).querySelector('[data-testid="annotation-track-status"]');

    expect(statusOf('terminators')?.textContent).toBe("Couldn't load this source.");
    expect(statusOf('terminators')?.getAttribute('title')).toBe(userMessage('tracks.loadFailed'));
    expect(statusOf('transcription-units')?.textContent).toBe('120 of 666 loaded');
    expect(screen.queryByText(/LicenseRef-/)).toBeNull();

    expect(friendlyLicenseName('CC0-1.0')).toBe('Public domain (CC0)');
    expect(friendlyLicenseName('CC-BY-4.0')).toBe('CC BY 4.0');
    expect(friendlyLicenseName('LicenseRef-DNAForge-generated')).toBe('Computed by DNAForge');
    expect(friendlyLicenseName('LicenseRef-SRI-BioCyc-Open-Database')).toBe('SRI BioCyc terms');
    expect(friendlyLicenseName('MIT')).toBe('MIT');
  });

  it('does not re-inspect the tab on store writes that leave its track layout alone', () => {
    const tabId = openTabWithCatalog();
    const listener = vi.fn();
    const stop = subscribeSequenceAnnotationTracks(tabId, listener);
    const panelId = 'main';

    useCanvasStore.getState().setTabViewState(panelId, tabId, { sequenceViewportCenterBp: 1_000 });
    useCanvasStore.getState().setTabViewState(panelId, tabId, { sequenceViewportZoomLevel: 2 });
    expect(listener).not.toHaveBeenCalled();

    updateSequenceAnnotationTracks({ ownerTabId: tabId, command: { kind: 'clear-layout' } });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('hides a track through the command boundary', () => {
    const tabId = openTabWithCatalog();
    render(<SequenceAnnotationTracksPanel ownerTabId={tabId} mapCircular={false} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Use default tracks' }));
    });

    act(() => {
      fireEvent.click(screen.getByLabelText('Show Terminators'));
    });

    const inspection = inspectSequenceAnnotationTracks(tabId);
    if (inspection.status !== 'found') throw new Error('tab should be found');
    const terminators = inspection.tracks.find((track) => track.binding.kind === 'terminator');
    expect(terminators?.binding.visible).toBe(false);
    expect(terminators?.resolution).toEqual({ status: 'hidden' });
  });

  it('explains that tracks need the linear map', () => {
    const tabId = openTabWithCatalog();
    render(<SequenceAnnotationTracksPanel ownerTabId={tabId} mapCircular />);
    expect(
      screen.getByText('These tracks draw on the linear map. Switch the map to linear to see them.')
    ).toBeTruthy();
  });
});
