import { useCommandRegistry } from '../commands/CommandScopeProvider';
import { useCommandHandler } from '../commands/useCommandHandler';
import { getHighestActiveFocusScope } from '../commands/commandRegistry';
import { COMMAND_IDS, COMMAND_SCOPES } from '../commands/types';
import { useLayoutEffect, useRef } from 'react';
import { useCanvasStore } from '../features/canvas/public/store';
import { saveTargetForTab } from '../features/canvas/public/artifact-document-lifecycle';
import { documentLifecycle, type DocumentLifecycleOwner } from './document-lifecycle';
import { saveDocumentTargetId } from './save-document-events';

function projectDirtyState(): void {
  const state = useCanvasStore.getState();
  for (const panel of Object.values(state.panels)) {
    for (const tab of panel.tabs) {
      const dirty = documentLifecycle.dirty(saveTargetForTab(tab), tab.id);
      if (dirty !== undefined && Boolean(tab.isDirty) !== dirty)
        state.updateTab(panel.id, tab.id, { isDirty: dirty });
    }
  }
}

documentLifecycle.subscribe(projectDirtyState);

export function useDocumentLifecycle(
  owner: (DocumentLifecycleOwner & Required<Pick<DocumentLifecycleOwner, 'discard'>>) | null
): void {
  const current = useRef(owner);
  current.current = owner;
  const kind = owner?.target.kind;
  const id = owner ? saveDocumentTargetId(owner.target) : undefined;
  const tabId = owner?.tabId;
  useLayoutEffect(() => {
    const initial = current.current;
    if (!initial) return;
    const registration = documentLifecycle.register({
      target: initial.target,
      reload: initial.reload
        ? () => current.current?.reload?.() ?? Promise.resolve(false)
        : undefined,
      tabId: initial.tabId,
      isDirty: () => current.current?.isDirty() ?? false,
      save: () => current.current?.save() ?? Promise.resolve(false),
      discard: async () => {
        await current.current?.discard();
      },
    });
    return registration.release;
  }, [kind, id, tabId]);
  useLayoutEffect(() => {
    documentLifecycle.changed();
  });
}

export function saveFocusedDocument(): boolean {
  const state = useCanvasStore.getState();
  const panel = state.focusedPanelId ? state.panels[state.focusedPanelId] : null;
  const tab = panel?.tabs.find((candidate) => candidate.id === panel.activeTabId);
  if (!tab || !documentLifecycle.has(saveTargetForTab(tab), tab.id)) return false;
  void documentLifecycle.save(saveTargetForTab(tab), tab.id);
  return true;
}

export function useDocumentSaveCommand(): void {
  const { getDebugState } = useCommandRegistry();
  useCommandHandler(
    COMMAND_IDS.fileSave,
    () => {
      const scope = getHighestActiveFocusScope(new Set(getDebugState().activeScopes));
      return scope !== COMMAND_SCOPES.sidebarFileTree && saveFocusedDocument();
    },
    { surfaceId: 'workspace' }
  );
}
