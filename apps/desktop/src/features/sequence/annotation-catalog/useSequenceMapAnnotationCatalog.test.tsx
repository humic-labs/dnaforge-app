import { renderHook, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  annotationCatalogForAccession,
  loadAnnotationCatalogs,
} from './annotation-catalog-registry';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';

beforeAll(async () => {
  await loadAnnotationCatalogs(bundledStoreBridge());
});

import {
  ANNOTATION_TRACK_LAYOUT_SCHEMA,
  BUILTIN_ANNOTATION_VISUALIZATIONS,
  DEFAULT_FILTER,
  DEFAULT_PRESENTATION,
  assemblyAccession,
  sourceId,
  trackBindingId,
  visualizationId,
  type AnnotationTrackLayout,
} from '@waypoint/genome-data/annotation-catalog';
import {
  annotationCatalogTrackType,
  createAnnotationCatalogTrackRenderers,
  type PixiLinearTrackRenderer,
} from '@waypoint/genome-renderer';
import type { Annotation } from '@waypoint/sequence-utils';

import { useCanvasStore } from '../../canvas/public/store';
import { readAnnotationCatalogWiring } from './annotation-catalog-wiring-status';
import { useSequenceMapAnnotationCatalog } from './useSequenceMapAnnotationCatalog';

vi.mock('@waypoint/genome-renderer', async () => {
  const actual = await vi.importActual<typeof import('@waypoint/genome-renderer')>(
    '@waypoint/genome-renderer'
  );
  return { ...actual, createAnnotationCatalogTrackRenderers: vi.fn() };
});

const DOCUMENT_ID = 'fixture:sequence:mg1655-wiring';

function gene(name: string, start1: number, end1: number): Annotation {
  return {
    name,
    type: 'gene',
    start: start1,
    end: end1,
    direction: 1,
    qualifiers: { gene: [name], locus_tag: [`b-${name}`] },
  };
}

const MG1655_DOCUMENT = {
  name: 'NC_000913',
  length: 4_641_652,
  sequence: '',
  annotations: [gene('thrA', 337, 2799), gene('thrB', 2801, 3733), gene('thrC', 3734, 5020)],
};

const LAYOUT: AnnotationTrackLayout = {
  schema: ANNOTATION_TRACK_LAYOUT_SCHEMA,
  assembly: assemblyAccession('NC_000913.3'),
  tracks: [
    {
      id: trackBindingId('transcription-units'),
      kind: 'transcription_unit',
      sourceId: sourceId('predicted-operons-50bp'),
      visualizationId: visualizationId('transcription-unit-arrows'),
      visible: true,
      label: null,
      presentation: DEFAULT_PRESENTATION,
      filter: DEFAULT_FILTER,
    },
  ],
};

function fakeTrackRenderers(): PixiLinearTrackRenderer[] {
  return BUILTIN_ANNOTATION_VISUALIZATIONS.map(
    (definition) =>
      ({ type: annotationCatalogTrackType(definition.id) }) as unknown as PixiLinearTrackRenderer
  );
}

function fakeMap() {
  const calls: string[] = [];
  const renderer = {
    setChromosome: vi.fn(() => {
      calls.push('setChromosome');
    }),
    registerTrack: vi.fn(() => {
      calls.push('registerTrack');
    }),
    setTrackInstances: vi.fn((tracks: ReadonlyArray<unknown>) => {
      calls.push(`setTrackInstances:${tracks.length}`);
    }),
    setTrackData: vi.fn(() => {
      calls.push('setTrackData');
    }),
  };
  const handle = {
    getLinearRenderer: () => renderer,
    requestRender: vi.fn(() => {
      calls.push('requestRender');
    }),
  };
  return { calls, renderer, mapRef: { current: handle } };
}

function options(
  mapRef: ReturnType<typeof fakeMap>['mapRef'],
  overrides: Partial<Parameters<typeof useSequenceMapAnnotationCatalog>[0]> = {}
): Parameters<typeof useSequenceMapAnnotationCatalog>[0] {
  return {
    entityId: DOCUMENT_ID,
    document: MG1655_DOCUMENT,
    viewTransformed: false,
    mapRef,
    rendererReadyEpoch: 1,
    mapCircular: false,
    layout: LAYOUT,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
  vi.mocked(createAnnotationCatalogTrackRenderers).mockReset();
  vi.mocked(createAnnotationCatalogTrackRenderers).mockImplementation(fakeTrackRenderers);
});

function openTab(): string {
  return useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: DOCUMENT_ID,
    label: 'MG1655',
    sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
  });
}

describe('useSequenceMapAnnotationCatalog', () => {
  it('sets the chromosome, registers, then publishes instances and data, and requests a render last', async () => {
    const tabId = openTab();
    const { calls, renderer, mapRef } = fakeMap();

    const { result } = renderHook(() => useSequenceMapAnnotationCatalog(options(mapRef)));

    await waitFor(() => expect(renderer.setTrackData).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({ ownerTabId: tabId, assemblyAccession: 'NC_000913.3' });
    expect(calls[0]).toBe('setChromosome');
    expect(calls.indexOf('setChromosome')).toBeLessThan(calls.indexOf('registerTrack'));
    expect(calls.indexOf('registerTrack')).toBeLessThan(calls.indexOf('setTrackInstances:1'));
    expect(calls.indexOf('setTrackInstances:1')).toBeLessThan(calls.indexOf('setTrackData'));
    expect(calls.at(-1)).toBe('requestRender');

    expect(renderer.setChromosome).toHaveBeenCalledWith({
      id: 'NC_000913.3',
      displayName: 'E. coli K-12 MG1655',
      length: 4_641_652,
      cytobands: [],
    });
    expect(renderer.setTrackInstances).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'transcription-units:transcription-unit-arrows',
        type: 'annotation-catalog:transcription-unit-arrows',
        order: 0,
        visible: true,
        assemblyId: 'NC_000913.3',
        zone: 'below-legacy',
        sizing: { kind: 'fitContent', minHeight: 28, maxHeight: 160 },
        label: 'Transcription units',
      }),
    ]);
    const [trackId, data] = renderer.setTrackData.mock.calls[0] as unknown as [
      string,
      {
        kind: string;
        records: { genes: string[] }[];
        genomeLengthBp: number;
        genesByName: ReadonlyMap<string, { name: string; start: number }>;
      },
    ];
    expect(trackId).toBe('transcription-units:transcription-unit-arrows');
    expect(data.kind).toBe('transcription_unit');
    expect(data.genomeLengthBp).toBe(4_641_652);
    expect(data.records.map((record) => record.genes)).toEqual([['thrA', 'thrB', 'thrC']]);
    expect(data.genesByName.get('thrB')).toBe(data.genesByName.get('b-thrB'));
    expect(data.genesByName.get('b-thrB')).toMatchObject({ name: 'thrB', start: 2800 });

    const wiring = readAnnotationCatalogWiring(tabId);
    expect(wiring?.drawing).toEqual({ phase: 'active' });
    expect(wiring?.tracks.get(trackBindingId('transcription-units'))).toEqual({
      status: 'ready',
      recordCount: 1,
      totalBeforeFilter: 1,
    });
    const operons = annotationCatalogForAccession('NC_000913.3')?.sources.get(
      sourceId('predicted-operons-50bp')
    );
    expect(wiring?.hoverTracks.map((track) => track.attribution)).toEqual([
      operons?.provenance.license.attribution,
    ]);
  });

  it('keeps the loaded records when the annotations change but the genes do not', async () => {
    openTab();
    const { renderer, mapRef } = fakeMap();
    const { rerender } = renderHook((props) => useSequenceMapAnnotationCatalog(props), {
      initialProps: options(mapRef),
    });
    await waitFor(() => expect(renderer.setTrackData).toHaveBeenCalledTimes(1));

    const note: Annotation = {
      name: 'draft',
      type: 'misc_feature',
      start: 10,
      end: 20,
      direction: 0,
    };
    rerender(
      options(mapRef, {
        document: {
          ...MG1655_DOCUMENT,
          annotations: [...MG1655_DOCUMENT.annotations.map((a) => ({ ...a })), note],
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderer.setTrackData).toHaveBeenCalledTimes(1);

    rerender(
      options(mapRef, {
        document: {
          ...MG1655_DOCUMENT,
          annotations: [gene('thrA', 337, 2799), gene('thrB', 2801, 3733)],
        },
      })
    );
    await waitFor(() => expect(renderer.setTrackData).toHaveBeenCalledTimes(2));
  });

  it('clears the tracks it drew when the map turns circular', async () => {
    openTab();
    const { calls, renderer, mapRef } = fakeMap();
    const { rerender } = renderHook((props) => useSequenceMapAnnotationCatalog(props), {
      initialProps: options(mapRef),
    });
    await waitFor(() => expect(renderer.setTrackData).toHaveBeenCalledTimes(1));
    calls.length = 0;

    rerender(options(mapRef, { mapCircular: true }));

    expect(renderer.setTrackInstances).toHaveBeenLastCalledWith([]);
    expect(calls).toEqual(['setTrackInstances:0', 'requestRender']);
  });

  it('clears the tracks when every track is hidden', async () => {
    openTab();
    const { renderer, mapRef } = fakeMap();
    const { rerender } = renderHook((props) => useSequenceMapAnnotationCatalog(props), {
      initialProps: options(mapRef),
    });
    await waitFor(() => expect(renderer.setTrackData).toHaveBeenCalledTimes(1));

    const hidden = {
      ...LAYOUT,
      tracks: LAYOUT.tracks.map((track) => ({ ...track, visible: false })),
    };
    rerender(options(mapRef, { layout: hidden }));

    expect(renderer.setTrackInstances).toHaveBeenLastCalledWith([]);
  });

  it('does nothing to the renderer for a document without a catalog', () => {
    openTab();
    const { renderer, mapRef } = fakeMap();
    const { result } = renderHook(() =>
      useSequenceMapAnnotationCatalog(
        options(mapRef, { document: { ...MG1655_DOCUMENT, name: 'pUC19', length: 2_686 } })
      )
    );
    expect(result.current).toBeNull();
    expect(renderer.setChromosome).not.toHaveBeenCalled();
    expect(renderer.setTrackInstances).not.toHaveBeenCalled();
  });

  it('reports an error instead of throwing when the track drawings are unavailable', async () => {
    const tabId = openTab();
    vi.mocked(createAnnotationCatalogTrackRenderers).mockImplementation(() => {
      throw new Error('createAnnotationCatalogTrackRenderers is not implemented yet');
    });
    const { renderer, mapRef } = fakeMap();

    renderHook(() => useSequenceMapAnnotationCatalog(options(mapRef)));

    await waitFor(() => expect(readAnnotationCatalogWiring(tabId)?.drawing.phase).toBe('error'));
    expect(renderer.setTrackData).not.toHaveBeenCalled();
    expect(renderer.setTrackInstances).not.toHaveBeenCalled();
  });
});
