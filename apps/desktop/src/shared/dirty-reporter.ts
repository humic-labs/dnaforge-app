import { platform } from '../platform';
import { SaveAllError, failedSaveAllResult } from './save-all-result';
import { usePageStore } from '../features/page/store';
import { useSequenceStore } from '../features/sequence/store';
import { saveAllDirtySequences } from '../features/sequence/save-all-sequences';
import { getNativeSequenceDocumentClient } from '../features/sequence/sequence-document-client';
import { ownsNativeFileDocument } from '../features/workspace/public/file-document-client';
import type { DirtyWorkItem } from './dirty-work-state';
import { isDesktopRuntime } from '../utils/environment';
import { isTabDirty, saveTargetForTab } from '../features/canvas/artifact-document-lifecycle';
import { documentLifecycle } from './document-lifecycle';
import { useCanvasStore } from '../features/canvas/store';
import { isKnownTabType, quitWorkPhrase, TAB_TYPES, type TabType } from './tab-kind';
import {
  hasUnrecoverableDesignWork,
  useDesignRecoveryStore,
} from '../features/design/design-recovery';

export function initDirtyReporter(): () => void {
  const publish = () => {
    try {
      const dirtyPageIds = [...usePageStore.getState().dirtyIds];
      const dirtySequenceDocumentIds = Object.keys(useSequenceStore.getState().dirtyPaths);
      const dirtyTabs = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
        panel.tabs.filter(isTabDirty)
      );
      const dirtyTabIds = dirtyTabs.map((tab) => tab.id);
      const dirtyFilePaths = dirtyTabs
        .filter((tab) => tab.type === 'text' && !tab.readOnly)
        .map((tab) => tab.entityId);
      const dirtyDesignIds = hasUnrecoverableDesignWork();
      const unsavedIds = emptyUnsavedIds();
      for (const tab of dirtyTabs) {
        if (!isKnownTabType(tab.type)) continue;
        unsavedIds[tab.type].add(unsavedIdentity(tab));
      }
      for (const id of dirtyPageIds) unsavedIds.page.add(id);
      for (const id of dirtySequenceDocumentIds) unsavedIds.sequence.add(id);
      for (const id of dirtyDesignIds) unsavedIds.design.add(id);

      const parts = TAB_TYPES.flatMap((type) => {
        const count = unsavedIds[type].size;
        return count > 0 ? [quitWorkPhrase(type, count)] : [];
      });
      const hasDirtyWork = parts.length > 0;
      const details = parts.join(' and ');
      const dirtyItems: DirtyWorkItem[] = TAB_TYPES.flatMap((kind) =>
        [...unsavedIds[kind]].map((id) => ({
          kind,
          id,
          ...(kind === 'sequence' || kind === 'page' ? { nativeDocumentId: id } : {}),
          ...(kind === 'text' || kind === 'file' || kind === 'table' ? { filePath: id } : {}),
        }))
      );

      platform().app.reportDirtyState({
        hasDirtyWork,
        details,
        dirtyPageIds,
        dirtySequenceDocumentIds,
        dirtyTabIds,
        dirtyFilePaths,
        ...(isDesktopRuntime() ? { dirtyItems } : {}),
      });
    } catch (err) {
      console.warn('[DirtyReporter] Failed to report dirty state:', err);
    }
  };

  publish();

  const unsubPage = usePageStore.subscribe((state, prev) => {
    if (state.dirtyIds !== prev.dirtyIds) publish();
  });
  const unsubSequence = useSequenceStore.subscribe((state, prev) => {
    if (state.dirtyPaths !== prev.dirtyPaths) publish();
  });
  const unsubCanvas = useCanvasStore.subscribe((state, prev) => {
    if (state.panels !== prev.panels) publish();
  });
  const unsubDesign = useDesignRecoveryStore.subscribe(publish);

  return () => {
    unsubPage();
    unsubSequence();
    unsubCanvas();
    unsubDesign();
  };
}

function emptyUnsavedIds(): Record<TabType, Set<string>> {
  return Object.fromEntries(TAB_TYPES.map((type) => [type, new Set<string>()])) as Record<
    TabType,
    Set<string>
  >;
}

function unsavedIdentity(tab: { id: string; entityId?: string }): string {
  const entityId = tab.entityId?.trim();
  return entityId ? entityId : tab.id;
}

export async function saveAllUnsavedWork(): Promise<void> {
  const bridge = platform();
  const nativeDocumentsSettled =
    isDesktopRuntime() && typeof bridge.fs?.settleDirtyDocuments === 'function';
  if (nativeDocumentsSettled) {
    const result = await bridge.fs.settleDirtyDocuments({ action: 'save' });
    if (result.failures.length || result.remaining.length) throw new SaveAllError(result.failures);
  }
  const nativeSequences = getNativeSequenceDocumentClient();
  const excluded = nativeDocumentsSettled
    ? new Set(
        Object.keys(useSequenceStore.getState().dirtyPaths).filter((id) =>
          nativeSequences?.owns(id)
        )
      )
    : new Set<string>();
  const pending: Array<Promise<unknown>> = [
    saveAllDirtySequences({ excludeDocumentIds: excluded }).then((result) => {
      if (!result.failed.length) return true;
      console.error('[Save All] Sequence saves not completed:', {
        documentIds: result.failed,
        failedCount: result.failed.length,
      });
      return false;
    }),
  ];
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    for (const tab of panel.tabs) {
      if (!isTabDirty(tab)) continue;
      const target = saveTargetForTab(tab);
      if (target.kind === 'sequence-document') continue;
      if (
        nativeDocumentsSettled &&
        target.kind === 'file' &&
        ownsNativeFileDocument(target.filePath)
      )
        continue;
      pending.push(documentLifecycle.save(target, tab.id));
    }
  }
  const results = await Promise.allSettled(pending);
  for (const result of results) {
    if (result.status === 'rejected') console.error('[Save All] Save failed:', result.reason);
  }
  if (results.some((result) => result.status === 'rejected' || result.value === false))
    throw new Error('Some documents still have unsaved work.');
}

export function initSaveAllHandler(): () => void {
  const bridge = platform();
  return bridge.on('app:saveAll', (requestId) => {
    void saveAllUnsavedWork().then(
      () => bridge.app.saveAllDone(requestId, { status: 'saved' }),
      (error) => {
        try {
          console.error('[Save All] Some changes were not saved:', error);
        } catch {}
        bridge.app.saveAllDone(requestId, failedSaveAllResult(error));
      }
    );
  });
}
