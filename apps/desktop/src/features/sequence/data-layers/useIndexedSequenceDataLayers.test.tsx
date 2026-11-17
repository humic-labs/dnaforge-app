import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IndexedGenomeTabState } from '../../../shared/indexed-genome';
import { sequenceDataLayerIndexedTargetId } from '../../../shared/sequence-data-layer-indexed-target';
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
