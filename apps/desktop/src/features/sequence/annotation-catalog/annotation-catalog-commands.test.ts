import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sourceId, trackBindingId } from '@waypoint/genome-data/annotation-catalog';

import { useCanvasStore } from '../../canvas/public/store';
import { sequenceViewMemoryKey } from '../view-state/sequence-view-state';
import {
  inspectSequenceAnnotationTracks,
  updateSequenceAnnotationTracks,
} from './annotation-catalog-commands';
import { PREDICTED_OPERONS_SOURCE_ID, loadAnnotationCatalogs } from './annotation-catalog-registry';
import { defaultLayoutFor } from './default-layout';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';

beforeAll(async () => {
  await loadAnnotationCatalogs(bundledStoreBridge());
});

const PANEL = 'main';
const DOCUMENT_ID = 'fixture:sequence:mg1655-annotation-catalog';

function openSequenceTab(): string {
  return useCanvasStore.getState().openTab(PANEL, {
    type: 'sequence',
    entityId: DOCUMENT_ID,
    label: 'MG1655',
    sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
  });
}

function tabViewState(tabId: string) {
  return useCanvasStore.getState().panels[PANEL]?.tabs.find((tab) => tab.id === tabId)?.viewState;
}

function useDefaultTracks(tabId: string) {
  const layout = defaultLayoutFor('NC_000913.3');
  expect(layout).not.toBeNull();
  const result = updateSequenceAnnotationTracks({
    ownerTabId: tabId,
    command: { kind: 'set-layout', layout },
  });
  expect(result.status).toBe('updated');
}

beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
});

describe('updateSequenceAnnotationTracks', () => {
  it('swaps a track to another source and persists it to the tab and reopen memory', () => {
    const tabId = openSequenceTab();
    useDefaultTracks(tabId);

    const result = updateSequenceAnnotationTracks({
      ownerTabId: tabId,
      command: {
        kind: 'set-source',
        trackId: trackBindingId('transcription-units'),
        sourceId: PREDICTED_OPERONS_SOURCE_ID,
      },
    });

    expect(result.status).toBe('updated');
    const inspection = inspectSequenceAnnotationTracks(tabId);
    if (inspection.status !== 'found') throw new Error('tab should be found');
    const units = inspection.tracks.find((track) => track.binding.id === 'transcription-units');
    expect(units?.binding.sourceId).toBe('predicted-operons-50bp');
    expect(units?.source?.evidenceLabel).toBe('Computed');
    expect(units?.source?.license.spdx).toBe('LicenseRef-DNAForge-generated');
    expect(units?.visualization?.label).toBe('Unit arrows');

    const memory = JSON.parse(localStorage.getItem(sequenceViewMemoryKey(DOCUMENT_ID)) ?? '{}');
    expect(
      memory.annotationCatalogLayout.tracks.find(
        (track: { id: string }) => track.id === 'transcription-units'
      ).sourceId
    ).toBe('predicted-operons-50bp');
  });

  it('rejects a swap to a source of the wrong kind and leaves view state byte-identical', () => {
    const tabId = openSequenceTab();
    useDefaultTracks(tabId);
    const viewStateBefore = tabViewState(tabId);
    const serializedBefore = JSON.stringify(viewStateBefore);
    const memoryBefore = localStorage.getItem(sequenceViewMemoryKey(DOCUMENT_ID));

    const result = updateSequenceAnnotationTracks({
      ownerTabId: tabId,
      command: {
        kind: 'set-source',
        trackId: trackBindingId('terminators'),
        sourceId: PREDICTED_OPERONS_SOURCE_ID,
      },
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.issues[0].code).toBe('source-wrong-kind');
    expect(tabViewState(tabId)).toBe(viewStateBefore);
    expect(JSON.stringify(tabViewState(tabId))).toBe(serializedBefore);
    expect(localStorage.getItem(sequenceViewMemoryKey(DOCUMENT_ID))).toBe(memoryBefore);
  });

  it('refuses the unavailable EcoCyc source without writing anything', () => {
    const tabId = openSequenceTab();
    useDefaultTracks(tabId);
    const serializedBefore = JSON.stringify(tabViewState(tabId));

    const result = updateSequenceAnnotationTracks({
      ownerTabId: tabId,
      command: {
        kind: 'set-source',
        trackId: trackBindingId('terminators'),
        sourceId: sourceId('ecocyc-open-database'),
      },
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.map((issue) => issue.code)).toContain('source-unavailable');
    }
    expect(JSON.stringify(tabViewState(tabId))).toBe(serializedBefore);
  });

  it('asks for a layout before accepting a track command on a tab without one', () => {
    const tabId = openSequenceTab();
    const result = updateSequenceAnnotationTracks({
      ownerTabId: tabId,
      command: { kind: 'set-visibility', trackId: trackBindingId('terminators'), visible: false },
    });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.issues[0].code).toBe('no-layout');
    expect(tabViewState(tabId)?.sequenceAnnotationCatalogLayout).toBeUndefined();
  });

  it('reports a missing tab', () => {
    openSequenceTab();
    expect(
      updateSequenceAnnotationTracks({
        ownerTabId: 'no-such-tab',
        command: { kind: 'clear-layout' },
      })
    ).toEqual({ status: 'missing' });
    expect(inspectSequenceAnnotationTracks('no-such-tab')).toEqual({ status: 'missing' });
  });
});

describe('inspectSequenceAnnotationTracks', () => {
  it('lists every kind with EcoCyc present but unavailable, and reports hidden tracks', () => {
    const tabId = openSequenceTab();
    useDefaultTracks(tabId);
    const inspection = inspectSequenceAnnotationTracks(tabId);
    if (inspection.status !== 'found') throw new Error('tab should be found');

    expect(inspection.assembly?.accession).toBe('NC_000913.3');
    const terminatorSources = inspection.choices.find((choice) => choice.kind === 'terminator');
    const ecocyc = terminatorSources?.sources.find(
      (source) => source.id === 'ecocyc-open-database'
    );
    expect(ecocyc?.availability.status).toBe('unavailable');
    expect(terminatorSources?.sources.at(-1)?.id).toBe('ecocyc-open-database');

    const startSites = inspection.tracks.find((track) => track.binding.kind === 'tss');
    expect(startSites?.resolution).toEqual({ status: 'hidden' });
  });
});
