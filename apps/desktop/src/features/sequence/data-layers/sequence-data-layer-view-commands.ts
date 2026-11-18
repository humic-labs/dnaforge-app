import { sequenceDataLayerIndexedTargetId } from '../../../shared/sequence-data-layer-indexed-target';
import { sequenceDataLayerSelectionFromSaved } from '../../../shared/saved-sequence-data-layers';
import { useCanvasStore } from '../../canvas/public/store';
import type { SequenceDataLayerViewSelection, Tab } from '../../canvas/public/types';
import { visibleSequenceDataLayerIds } from './sequence-data-layer-selection';
import {
  modelPatchToTabViewState,
  normalizeSequenceViewStatePatch,
  readSequenceViewMemory,
  resolveSeededViewState,
  tabViewStateToModelPatch,
  writeSequenceViewMemory,
} from '../view-state/sequence-view-state';

export interface SequenceDataLayerViewTarget {
  readonly tabId: string;
  readonly documentId: string;
  readonly selection: SequenceDataLayerViewSelection | null;
}

function layerTargetDocumentId(tab: Tab): string | undefined {
  if (!tab.indexedGenome) return tab.entityId;
  const genome = tab.indexedGenome;
  if (genome.contactProjection || genome.comparisonProjection) return undefined;
  return genome.assembly && genome.assemblyReferenceIdentity
    ? sequenceDataLayerIndexedTargetId({
        referenceId: genome.assembly.assemblyId,
        chrom: genome.chrom,
        ...genome.assemblyReferenceIdentity,
      })
    : undefined;
}

function currentSelection(tab: Tab): SequenceDataLayerViewSelection | null {
  if (tab.indexedGenome)
    return Object.hasOwn(tab.viewState ?? {}, 'sequenceDataLayerSelection')
      ? (tab.viewState?.sequenceDataLayerSelection ?? null)
      : (sequenceDataLayerSelectionFromSaved(tab.indexedGenome.sequenceDataLayers) ?? null);
  return (
    resolveSeededViewState({
      tab: tabViewStateToModelPatch(tab.viewState),
      memory: readSequenceViewMemory(tab.entityId),
    }).dataLayerSelection ?? null
  );
}

export function captureSequenceDataLayerViews(documentId: string): SequenceDataLayerViewTarget[] {
  return Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
    panel.tabs
      .filter((tab) => tab.type === 'sequence' && layerTargetDocumentId(tab) === documentId)
      .map((tab) => ({ tabId: tab.id, documentId, selection: currentSelection(tab) }))
  );
}

export function selectSequenceDataLayerView(
  target: SequenceDataLayerViewTarget,
  selection: SequenceDataLayerViewSelection | null
): 'updated' | 'closed' | 'changed' | 'invalid' {
  const normalized = normalizeSequenceViewStatePatch({ dataLayerSelection: selection });
  if (!('dataLayerSelection' in normalized)) return 'invalid';
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    const tab = panel.tabs.find((entry) => entry.id === target.tabId);
    if (!tab) continue;
    if (tab.type !== 'sequence' || layerTargetDocumentId(tab) !== target.documentId)
      return 'changed';
    if (JSON.stringify(currentSelection(tab)) !== JSON.stringify(target.selection))
      return 'changed';
    const incoming = normalized.dataLayerSelection;
    const previous = currentSelection(tab);
    let next = incoming;
    if (incoming && previous?.project === incoming.project) {
      const visible = visibleSequenceDataLayerIds(previous);
      const appended = incoming.layerId !== null && incoming.layerId !== previous.layerId;
      next = {
        ...incoming,
        ...(incoming.presentationByLayerId === undefined && previous.presentationByLayerId
          ? { presentationByLayerId: previous.presentationByLayerId }
          : {}),
        ...(incoming.visibleLayerIds === undefined &&
        incoming.layerId !== null &&
        (previous.visibleLayerIds !== undefined || appended)
          ? { visibleLayerIds: [...new Set([...visible, incoming.layerId])] }
          : {}),
      };
    }
    const patch = normalizeSequenceViewStatePatch({ dataLayerSelection: next });
    if (!('dataLayerSelection' in patch)) return 'invalid';
    useCanvasStore.getState().setTabViewState(panel.id, tab.id, modelPatchToTabViewState(patch));
    writeSequenceViewMemory(tab.entityId, patch);
    return 'updated';
  }
  return 'closed';
}
