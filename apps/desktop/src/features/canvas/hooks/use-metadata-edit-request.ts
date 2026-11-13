import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../store';
import type { MetadataEditorTabType } from '../types';

export function useMetadataEditRequest(
  tabId: string | undefined,
  editor: MetadataEditorTabType,
  openMetadata: (requestId: string) => void | false,
  enabled = true
): void {
  const open = useRef(openMetadata);
  open.current = openMetadata;
  const requestId = useCanvasStore(
    (state) =>
      Object.values(state.panels)
        .flatMap((panel) => panel.tabs)
        .find((tab) => tab.id === tabId && tab.type === editor)?.viewState?.metadataEditRequestId
  );
  useEffect(() => {
    if (!enabled || !requestId || !tabId) return;
    if (open.current(requestId) === false) return;
    const store = useCanvasStore.getState();
    const owner = Object.values(store.panels).find((panel) =>
      panel.tabs.some(
        (tab) =>
          tab.id === tabId &&
          tab.type === editor &&
          tab.viewState?.metadataEditRequestId === requestId
      )
    );
    if (owner) store.setTabViewState(owner.id, tabId, { metadataEditRequestId: undefined });
  }, [requestId, tabId, editor, enabled]);
}
