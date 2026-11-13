import { useCanvasStore } from './store';
import type { Tab } from './types';
import type {
  DocumentContentState,
  DocumentOpenResult,
  OpenStrategy,
} from './document-presentation';

export function captureDocumentActivation() {
  const { focusedPanelId, panels } = useCanvasStore.getState();
  const tabs = new Map(Object.entries(panels).map(([id, panel]) => [id, panel.activeTabId]));
  let current = true;
  let unsubscribe: (() => void) | undefined;
  const dispose = () => {
    current = false;
    unsubscribe?.();
  };
  unsubscribe = useCanvasStore.subscribe((state) => {
    if (
      state.focusedPanelId !== focusedPanelId ||
      Object.keys(state.panels).length !== tabs.size ||
      Object.entries(state.panels).some(([id, panel]) => tabs.get(id) !== panel.activeTabId)
    )
      dispose();
  });
  return { isCurrent: () => current, dispose };
}

export function presentDocument(
  tab: Omit<Tab, 'id'>,
  placement: OpenStrategy = { kind: 'focused' },
  content: DocumentContentState = 'loading'
): DocumentOpenResult {
  const store = useCanvasStore.getState();
  const previousIds = new Set(
    Object.values(store.panels).flatMap((panel) => panel.tabs.map((item) => item.id))
  );
  const { type, entityId, label, initialStructureAttrs, ...options } = tab;
  const tabId =
    placement.kind === 'panel'
      ? store.openTab(placement.panelId, tab)
      : placement.kind === 'smart'
        ? store.openWithSmartPlacement(type, entityId, label, initialStructureAttrs, options)
        : store.openInFocusedPanel(type, entityId, label, { initialStructureAttrs, ...options });
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    if (!tabId || !panel.tabs.some((item) => item.id === tabId)) continue;
    return {
      status: 'presented',
      tabId,
      panelId: panel.id,
      tabType: type,
      disposition: previousIds.has(tabId) ? 'reused' : 'created',
      content,
    };
  }
  return { status: 'failed', message: 'The destination panel is no longer available.' };
}
