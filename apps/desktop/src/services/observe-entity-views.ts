import { useCanvasStore } from '../features/canvas/public/store';
import { getCatalogEntity, getCatalogEntityForFilePath } from '../db/workspace-catalog';
import { useEntityViewHistory } from './recent-entity-views';

export function observeEntityViews(): () => void {
  let activeKey: string | null = null;
  let generation = 0;
  const capture = () => {
    const state = useCanvasStore.getState();
    const panel = state.focusedPanelId ? state.panels[state.focusedPanelId] : null;
    const tab = panel?.tabs.find((candidate) => candidate.id === panel.activeTabId);
    const documentPath = tab?.trackView?.path ?? tab?.initialStructureAttrs?.molecularDocumentPath;
    const entityId =
      tab?.initialStructureAttrs?.structureArtifactRef?.entityId ??
      (tab?.sequenceDocument?.kind === 'catalog-sequence'
        ? tab.sequenceDocument.entityId
        : tab?.entityId);
    const key = tab ? `${tab.id}:${documentPath ?? entityId}:${tab.loadStatus ?? 'loaded'}` : null;
    if (key === activeKey) return;
    activeKey = key;
    const current = ++generation;
    if (!tab || (tab.loadStatus && !['loaded', 'indexed'].includes(tab.loadStatus))) return;
    const viewedAt = Date.now();
    const sourcePath =
      documentPath ??
      (tab.sequenceDocument?.kind === 'import-source-sequence'
        ? tab.sequenceDocument.sourcePath
        : (tab.initialStructureAttrs?.structureArtifactRef?.artifactPath ?? tab.entityId));
    const resolve = documentPath
      ? getCatalogEntityForFilePath(documentPath)
      : getCatalogEntity(entityId ?? tab.entityId).then(
          (entity) => entity ?? getCatalogEntityForFilePath(sourcePath)
        );
    void resolve
      .then((entity) => {
        if (current === generation && entity?.status === 'active')
          useEntityViewHistory.getState().recordView(entity.id, viewedAt);
      })
      .catch((error: unknown) => console.error('Failed to record entity view:', error));
  };
  const unsubscribe = useCanvasStore.subscribe(capture);
  capture();
  return () => {
    generation++;
    unsubscribe();
  };
}
