import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IndexedGenomeTabState } from '../../../shared/indexed-genome';
import { sequenceDataLayerIndexedTargetId } from '../../../shared/sequence-data-layer-indexed-target';
import type { PublishedSequenceDataLayer } from '../../../shared/sequence-data-layer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import { useIndexedSequenceDataLayers } from './useIndexedSequenceDataLayers';

const { run, load } = vi.hoisted(() => ({ run: vi.fn(), load: vi.fn() }));
vi.mock('../../../platform', () => ({ platform: () => ({ sequenceDataLayers: { run } }) }));
vi.mock('./useSequenceDataLayers', () => ({ useSavedSequenceDataLayers: load }));

beforeEach(() => {
  run.mockReset();
  load.mockReset().mockReturnValue({ loadedLayers: [], trackControls: { errors: [] }, tracks: [] });
  useCanvasStore.getState().reset();
  useWorkspaceStore.setState({ folders: [{ name: 'Measurements', path: '/project', addedAt: 1 }] });
});

afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
  useWorkspaceStore.setState({ folders: [] });
});

it('loads the selected dataset when canonical tab state changes while the incoming tab prop stays unchanged', async () => {
  const identity = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };
  const genome: IndexedGenomeTabState = {
    sourcePath: '/reference/genome.fa',
    sourceExt: 'fa',
    chrom: 'NC_000913.3',
    assembly: { assemblyId: 'MG1655', displayName: 'E. coli', chromosomes: [] },
    assemblyReferenceIdentity: identity,
  };
  const store = useCanvasStore.getState();
  const tabId = store.openTab('main', {
    type: 'sequence',
    label: 'E. coli',
    entityId: 'indexed-ecoli',
    indexedGenome: genome,
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'indexed-ecoli' },
  });
  const incomingTab = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!;
  const targetDocumentId = sequenceDataLayerIndexedTargetId({
    referenceId: genome.assembly!.assemblyId,
    chrom: genome.chrom,
    ...identity,
  });
  const pins = {
    sequenceFingerprint: `sha256:${'c'.repeat(64)}`,
    annotationFingerprint: `annotation-mapping-v1:sha256:${'d'.repeat(64)}`,
  };
  run.mockResolvedValue({
    status: 'target',
    target: { documentId: targetDocumentId, length: 4_641_652, ...pins },
    annotationIdentifiers: [],
  });
  renderHook(() => useIndexedSequenceDataLayers(incomingTab, genome));
  expect(run).not.toHaveBeenCalled();
  expect(load.mock.lastCall?.[0]).toMatchObject({ project: '', enabled: false });

  const selection = { project: '/project', layerId: `layer-${'e'.repeat(64)}` };
  act(() => {
    useCanvasStore.getState().setTabViewState('main', tabId, {
      sequenceDataLayerSelection: selection,
    });
  });

  await waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      operation: 'target',
      project: '/project',
      targetDocumentId,
    })
  );
  await waitFor(() =>
    expect(load.mock.lastCall?.[0]).toMatchObject({
      documentId: targetDocumentId,
      project: '/project',
      selection,
      fingerprints: pins,
      enabled: true,
    })
  );
  expect(incomingTab.viewState?.sequenceDataLayerSelection).toBeUndefined();
  expect(useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)).not.toBe(
    incomingTab
  );
});

function indexedLayerReadinessFixture(savedRevision?: string) {
  const identity = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };
  const pins = {
    sequenceFingerprint: `sha256:${'c'.repeat(64)}`,
    annotationFingerprint: `annotation-mapping-v1:sha256:${'d'.repeat(64)}`,
  };
  const targetDocumentId = sequenceDataLayerIndexedTargetId({
    referenceId: 'MG1655',
    chrom: 'NC_000913.3',
    ...identity,
  });
  const presentation = {
    sampleId: 'value',
    signalVisible: true,
    annotationColors: false,
    style: {
      geometry: 'points' as const,
      colorScale: {
        kind: 'continuous' as const,
        domain: [0, 1] as [number, number],
        colors: ['#000000', '#ffffff'],
        missingColor: '#cccccc',
        transform: 'linear' as const,
      },
    },
  };
  const layers = ['e', 'f'].map(
    (digit) =>
      ({
        revision: digit.repeat(64),
        document: {
          id: `layer-${digit.repeat(64)}`,
          target: { documentId: targetDocumentId, length: 4_641_652, ...pins },
          presentation,
        },
      }) as PublishedSequenceDataLayer
  );
  const [first, second] = layers;
  const genome: IndexedGenomeTabState = {
    sourcePath: '/reference/genome.fa',
    sourceExt: 'fa',
    chrom: 'NC_000913.3',
    assembly: { assemblyId: 'MG1655', displayName: 'E. coli', chromosomes: [] },
    assemblyReferenceIdentity: identity,
    ...(savedRevision
      ? {
          sequenceDataLayers: {
            project: '/project',
            targetDocumentId,
            selectedLayerId: first.document.id,
            visibleLayerIds: [first.document.id],
            layers: [{ id: first.document.id, revision: savedRevision, presentation }],
          },
        }
      : {}),
  };
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    label: 'E. coli',
    entityId: 'indexed-ecoli',
    indexedGenome: genome,
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'indexed-ecoli' },
    viewState: {
      sequenceDataLayerSelection: {
        project: '/project',
        layerId: first.document.id,
        visibleLayerIds: [first.document.id],
      },
    },
  });
  const incomingTab = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!;
  run.mockResolvedValue({
    status: 'target',
    target: { documentId: targetDocumentId, length: 4_641_652, ...pins },
    annotationIdentifiers: [],
  });
  return { genome, tabId, incomingTab, first, second, pins, targetDocumentId };
}

it('waits for every canonically selected indexed layer before a saved track view can capture it', async () => {
  const { genome, tabId, incomingTab, first, second, pins, targetDocumentId } =
    indexedLayerReadinessFixture();
  load.mockReturnValue({ loadedLayers: [first], trackControls: { errors: [] }, tracks: [] });
  const { result, rerender } = renderHook(() => useIndexedSequenceDataLayers(incomingTab, genome));
  await waitFor(() => expect(load.mock.lastCall?.[0].fingerprints).toEqual(pins));
  expect(result.current.ready).toBe(true);
  expect(result.current.capture()?.layers.map((layer) => layer.id)).toEqual([first.document.id]);

  act(() => {
    useCanvasStore.getState().setTabViewState('main', tabId, {
      sequenceDataLayerSelection: {
        project: '/project',
        layerId: second.document.id,
        visibleLayerIds: [first.document.id, second.document.id],
      },
    });
  });

  expect(load.mock.lastCall?.[0].selection).toMatchObject({
    layerId: second.document.id,
    visibleLayerIds: [first.document.id, second.document.id],
  });
  expect(result.current.loadedLayers).toEqual([first]);
  expect(result.current.ready).toBe(false);

  load.mockReturnValue({
    loadedLayers: [first, second],
    trackControls: { errors: [] },
    tracks: [],
  });
  rerender();

  expect(result.current.ready).toBe(true);
  expect(result.current.capture()).toMatchObject({
    targetDocumentId,
    selectedLayerId: second.document.id,
    visibleLayerIds: [first.document.id, second.document.id],
    layers: [
      { id: first.document.id, revision: first.revision },
      { id: second.document.id, revision: second.revision },
    ],
  });
});

it('does not report a saved indexed layer ready when its retained revision differs', async () => {
  const pinnedRevision = '9'.repeat(64);
  const { genome, incomingTab, first, pins } = indexedLayerReadinessFixture(pinnedRevision);
  load.mockReturnValue({ loadedLayers: [first], trackControls: { errors: [] }, tracks: [] });
  const { result, rerender } = renderHook(() => useIndexedSequenceDataLayers(incomingTab, genome));
  await waitFor(() => expect(load.mock.lastCall?.[0].fingerprints).toEqual(pins));

  expect(load.mock.lastCall?.[0].pinnedRevisions).toEqual({
    [first.document.id]: pinnedRevision,
  });
  expect(result.current.ready).toBe(false);

  load.mockReturnValue({
    loadedLayers: [{ ...first, revision: pinnedRevision }],
    trackControls: { errors: [] },
    tracks: [],
  });
  rerender();

  expect(result.current.ready).toBe(true);
  expect(result.current.capture()?.layers).toMatchObject([
    { id: first.document.id, revision: pinnedRevision },
  ]);
});
