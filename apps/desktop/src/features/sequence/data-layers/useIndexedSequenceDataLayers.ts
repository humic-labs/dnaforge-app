import { useCallback, useEffect, useMemo, useState } from 'react';
import { platform } from '../../../platform';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { sequenceDataLayerIndexedTargetId } from '../../../shared/sequence-data-layer-indexed-target';
import {
  captureSavedSequenceDataLayers,
  sequenceDataLayerSelectionFromSaved,
} from '../../../shared/saved-sequence-data-layers';
import type { IndexedGenomeTabState } from '../../../shared/indexed-genome';
import type { Tab } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { SEQUENCE_DATA_LAYERS_CHANGED } from '../../../shared/sequence-data-layer';
import type { SequenceDataLayerViewSelection } from '../../../shared/sequence-data-layer';
import {
  useSavedSequenceDataLayers,
  type SequenceDataLayerTargetFingerprints,
} from './useSequenceDataLayers';

export function useIndexedSequenceDataLayers(tab: Tab, genome: IndexedGenomeTabState | null) {
  const folders = useWorkspaceStore((state) => state.folders);
  const saved = genome?.sequenceDataLayers;
  const restoredSelection = useMemo(() => sequenceDataLayerSelectionFromSaved(saved), [saved]);
  const liveSelection = useCanvasStore(
    (state) =>
      Object.values(state.panels)
        .flatMap((panel) => panel.tabs)
        .find((candidate) => candidate.id === tab.id)?.viewState?.sequenceDataLayerSelection
  );
  const selection = liveSelection === undefined ? restoredSelection : (liveSelection ?? undefined);
  const selectedProject = selection?.project;
  const project = selectedProject
    ? (resolveExplicitProjectRoot(folders, selectedProject)?.path ?? '')
    : '';
  const referenceId = genome?.assembly?.assemblyId;
  const chrom = genome?.chrom;
  const identity = genome?.assemblyReferenceIdentity;
  const documentId = useMemo(
    () =>
      referenceId && chrom && identity
        ? sequenceDataLayerIndexedTargetId({ referenceId, chrom, ...identity })
        : undefined,
    [referenceId, chrom, identity?.sequenceIdentity, identity?.annotationIdentity]
  );
  const enabled = Boolean(
    project && documentId && !genome?.contactProjection && !genome?.comparisonProjection
  );
  const key = `${project}\0${documentId ?? ''}`;
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const update = () => setRefresh((value) => value + 1);
    window.addEventListener(SEQUENCE_DATA_LAYERS_CHANGED, update);
    return () => window.removeEventListener(SEQUENCE_DATA_LAYERS_CHANGED, update);
  }, []);
  const [native, setNative] = useState<
    | { key: string; kind: 'ready'; pins: SequenceDataLayerTargetFingerprints }
    | { key: string; kind: 'error'; message: string }
    | null
  >(null);
  useEffect(() => {
    if (!enabled || !documentId) return;
    let current = true;
    void platform()
      .sequenceDataLayers.run({ operation: 'target', project, targetDocumentId: documentId })
      .then((result) => {
        if (!current) return;
        if (result.status !== 'target' || !result.target.annotationFingerprint)
          throw new Error(
            result.status === 'failed' ? result.message : 'The indexed layer target is unavailable.'
          );
        setNative({
          key,
          kind: 'ready',
          pins: {
            sequenceFingerprint: result.target.sequenceFingerprint,
            annotationFingerprint: result.target.annotationFingerprint,
          },
        });
      })
      .catch((error: unknown) => {
        if (current)
          setNative({
            key,
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      current = false;
    };
  }, [documentId, enabled, key, project, refresh]);
  const onSelectionChange = useCallback(
    (next: SequenceDataLayerViewSelection | null) => {
      const store = useCanvasStore.getState();
      const panel = Object.values(store.panels).find((panel) =>
        panel.tabs.some((candidate) => candidate.id === tab.id)
      );
      if (panel) store.setTabViewState(panel.id, tab.id, { sequenceDataLayerSelection: next });
    },
    [tab.id]
  );
  const pinnedRevisions = useMemo(
    () =>
      saved
        ? Object.fromEntries(saved.layers.map((layer) => [layer.id, layer.revision]))
        : undefined,
    [saved]
  );
  const layers = useSavedSequenceDataLayers({
    documentId,
    project,
    fingerprints: native?.key === key && native.kind === 'ready' ? native.pins : null,
    selection: selection ?? undefined,
    onSelectionChange,
    pinnedRevisions,
    enabled,
  });
  const capture = () => {
    if (!selection || !documentId) return undefined;
    return captureSavedSequenceDataLayers(
      documentId,
      selection,
      layers.loadedLayers,
      pinnedRevisions
    );
  };
  return {
    ...layers,
    annotationColorsByIdentity: undefined,
    missingColor: undefined,
    ready: !selection || (enabled && layers.loadedLayers !== null),
    capture,
    trackControls: {
      ...layers.trackControls,
      annotationColorsSupported: false,
      errors: [
        ...layers.trackControls.errors,
        ...(native?.key === key && native.kind === 'error' ? [native.message] : []),
      ],
    },
  };
}
