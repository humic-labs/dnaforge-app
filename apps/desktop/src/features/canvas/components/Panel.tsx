import { PresentationBoundary } from '../../../presentation/PresentationSurface';
import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { usePresentationScope } from '../../../presentation/PresentationSurface';
import { userMessage } from '@waypoint/user-messages';
import { findUnsettledEntityDetailsSession } from '../../entity-details/public/editing-sessions';
import { requestManagedSequenceMetadata } from '../../sequence/public/managed-sequence-metadata';
import React, { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { TabBar } from './TabBar';
import { TabPortalTarget } from './TabPortalTarget';
import { EmptyPanel } from './EmptyPanel';
import { CloseConfirmationDialog } from './CloseConfirmationDialog';
import { useCanvasStore } from '../store';
import type { PanelState, Tab } from '../types';
import { documentLifecycle } from '../../../shared/document-lifecycle';
import {
  announceArtifactDraftDiscard,
  isEphemeralArtifactDraft,
  isTabDirty,
  saveTargetForTab,
} from '../artifact-document-lifecycle';
import {
  newCanvasNavigationOperation,
  observeCanvasNavigation,
  observeCanvasClose,
  type CanvasNavigationOperation,
} from '../navigation-observation';
import { useCommandHandler } from '../../../commands/useCommandHandler';
import { useCommandRegistry } from '../../../commands/CommandScopeProvider';
import { useCommandScope } from '../../../commands/useCommandScope';
import { keyboardCommandBelongsToTarget } from '../../../commands/commandRegistry';
import { COMMAND_IDS, COMMAND_SCOPES } from '../../../commands/types';
import { matchesAppShortcut } from '../../../keyboard/shortcutRegistry';
import { platform } from '../../../platform';
import { isDesktopRuntime } from '../../../utils/environment';
import {
  registerCanvasReadRequest,
  commitCanvasReadPlacement,
  cancelCanvasReadRequest,
} from '../../../lib/readable-content-telemetry';

interface PanelProps {
  panel: PanelState;
  isFocused: boolean;
}

export const Panel = React.memo(function Panel(props: PanelProps) {
  const focused = useCanvasStore((state) => state.focusedPanelId === props.panel.id);
  return (
    <PresentationBoundary id={`panel-${props.panel.id}`} focused={focused} layout="fill">
      <PanelBody {...props} />
    </PresentationBoundary>
  );
});

function PanelBody({ panel, isFocused }: PanelProps) {
  const presentationEvents = usePresentationListener();
  const presentation = usePresentationScope();

  const setActiveTab = useCanvasStore((state) => state.setActiveTab);
  const closeTab = useCanvasStore((state) => state.closeTab);
  const reorderTab = useCanvasStore((state) => state.reorderTab);
  const focusPanel = useCanvasStore((state) => state.focusPanel);
  const { dispatchCommand, getDebugState } = useCommandRegistry();
  const documentScope = useCommandScope(COMMAND_SCOPES.canvasPanel, { enabled: isFocused });

  const [pendingCloseTab, setPendingCloseTab] = useState<Tab | null>(null);
  const [waitingForSave, setWaitingForSave] = useState(false);
  const closeQueue = useRef<string[]>([]);
  const bulkCloseOriginalTabRef = useRef<string | null>(null);
  const pendingVisibleTabSwitchRef = useRef<{
    tabId: string;
    type: Tab['type'];
    entityId: string;
    operation: CanvasNavigationOperation | null;
  } | null>(null);
  const saveRequestedRef = useRef<string | null>(null);
  const pendingReadOperationRef = useRef<CanvasNavigationOperation | null>(null);
  const pendingCloseOperationRef = useRef<CanvasNavigationOperation | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const activeTab = panel.tabs.find((t) => t.id === panel.activeTabId) || null;

  const handleFocus = useCallback(() => {
    if (useCanvasStore.getState().focusedPanelId !== panel.id) {
      focusPanel(panel.id);
    }
  }, [focusPanel, panel.id]);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;

    element.addEventListener('pointerdown', handleFocus, true);
    return () => element.removeEventListener('pointerdown', handleFocus, true);
  }, [handleFocus]);

  const handleSelectTab = useCallback(
    (tabId: string) => {
      const current = useCanvasStore.getState().panels[panel.id];
      const target = current?.tabs.find((tab) => tab.id === tabId);
      const operation = newCanvasNavigationOperation();
      if (!current || !target) {
        observeCanvasNavigation(operation, 'refused');
        return false;
      }
      if (tabId === current.activeTabId) {
        observeCanvasNavigation(operation, 'noop');
        return false;
      }
      const prior = pendingVisibleTabSwitchRef.current;
      if (prior) observeCanvasNavigation(prior.operation, 'superseded');
      cancelCanvasReadRequest(pendingReadOperationRef.current);
      pendingReadOperationRef.current = null;
      pendingVisibleTabSwitchRef.current = {
        tabId,
        type: target.type,
        entityId: target.entityId,
        operation,
      };
      observeCanvasNavigation(operation, 'accepted');
      try {
        presentation.owner.dispatch({ type: 'focus', id: presentation.id });
        setActiveTab(panel.id, tabId);
      } catch (error) {
        pendingVisibleTabSwitchRef.current = null;
        observeCanvasNavigation(operation, 'refused');
        throw error;
      }
      const next = useCanvasStore.getState();
      if (next.panels[panel.id]?.activeTabId !== tabId || next.focusedPanelId !== panel.id) {
        pendingVisibleTabSwitchRef.current = null;
        observeCanvasNavigation(operation, 'refused');
        return false;
      }
      pendingReadOperationRef.current = operation;
      registerCanvasReadRequest({ panelId: panel.id, tabId, operation });
      return true;
    },
    [setActiveTab, panel.id, presentation]
  );

  useEffect(() => {
    const pending = pendingVisibleTabSwitchRef.current;
    if (!pending) return;
    const state = useCanvasStore.getState();
    const target = state.panels[panel.id]?.tabs.find((tab) => tab.id === pending.tabId);
    if (
      !isFocused ||
      state.focusedPanelId !== panel.id ||
      !target ||
      target.type !== pending.type ||
      target.entityId !== pending.entityId ||
      state.panels[panel.id]?.activeTabId !== pending.tabId
    ) {
      pendingVisibleTabSwitchRef.current = null;
      observeCanvasNavigation(pending.operation, 'superseded');
      cancelCanvasReadRequest(pending.operation);
      return;
    }
    const renderedTarget = panel.tabs.find((tab) => tab.id === pending.tabId);
    if (
      panel.activeTabId !== pending.tabId ||
      !renderedTarget ||
      renderedTarget.type !== pending.type ||
      renderedTarget.entityId !== pending.entityId
    )
      return;
    pendingVisibleTabSwitchRef.current = null;
    observeCanvasNavigation(pending.operation, 'placed');
    commitCanvasReadPlacement(pending.operation);
  }, [isFocused, panel.id, panel.activeTabId, panel.tabs]);

  useEffect(
    () => () => {
      const pending = pendingVisibleTabSwitchRef.current;
      pendingVisibleTabSwitchRef.current = null;
      if (pending) observeCanvasNavigation(pending.operation, 'unmounted');
      cancelCanvasReadRequest(pendingReadOperationRef.current);
      pendingReadOperationRef.current = null;
      observeCanvasClose(pendingCloseOperationRef.current, 'unmounted');
      pendingCloseOperationRef.current = null;
    },
    []
  );

  const advanceCloseQueue = useCallback(() => {
    saveRequestedRef.current = null;
    setWaitingForSave(false);
    setPendingCloseTab(null);
    for (;;) {
      const tabId = closeQueue.current.shift();
      if (!tabId) {
        bulkCloseOriginalTabRef.current = null;
        return;
      }
      const tab = useCanvasStore
        .getState()
        .panels[panel.id]?.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) continue;
      pendingCloseOperationRef.current = newCanvasNavigationOperation();
      observeCanvasClose(pendingCloseOperationRef.current, 'requested');
      const metadata = findUnsettledEntityDetailsSession(
        [
          tab.entityId,
          tab.viewState?.entityDetailsEntityId ?? '',
          tab.trackView?.document.id ?? '',
        ],
        [
          tab.entityId,
          tab.artifactDocument?.artifactPath ?? '',
          tab.initialStructureAttrs?.molecularDocumentPath ?? '',
        ]
      );
      if (metadata) {
        setActiveTab(panel.id, tab.id);
        if (tab.type === 'sequence' && !tab.trackView && !tab.indexedGenome)
          requestManagedSequenceMetadata(
            metadata.getSnapshot().definition?.record.sequence?.ref?.packageId ??
              metadata.target.sequenceFile?.documentId ??
              tab.entityId
          );
        else
          useCanvasStore.getState().setTabViewState(panel.id, tab.id, {
            entityDetailsOpen: true,
            entityDetailsEntityId: metadata.target.entityId,
          });
        metadata.showError(userMessage('record.finishMetadataBeforeClosing'));
        observeCanvasClose(pendingCloseOperationRef.current, 'refused');
        pendingCloseOperationRef.current = null;
        bulkCloseOriginalTabRef.current = null;
        return;
      }
      if (isTabDirty(tab)) {
        setActiveTab(panel.id, tab.id);
        setPendingCloseTab(tab);
        return;
      }
      if (isEphemeralArtifactDraft(tab)) announceArtifactDraftDiscard(tab.id);
      closeTab(panel.id, tabId);
      const removed = !useCanvasStore
        .getState()
        .panels[panel.id]?.tabs.some((candidate) => candidate.id === tabId);
      observeCanvasClose(pendingCloseOperationRef.current, removed ? 'closed' : 'refused');
      pendingCloseOperationRef.current = null;
    }
  }, [closeTab, panel.id, setActiveTab]);

  const beginCloseRequest = useCallback(
    (tabIds: readonly string[]) => {
      if (pendingCloseTab) return;
      closeQueue.current = [...new Set(tabIds)];
      bulkCloseOriginalTabRef.current =
        closeQueue.current.length > 1
          ? (useCanvasStore.getState().panels[panel.id]?.activeTabId ?? null)
          : null;
      advanceCloseQueue();
    },
    [advanceCloseQueue, panel.id, pendingCloseTab]
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      beginCloseRequest([tabId]);
    },
    [beginCloseRequest]
  );

  useEffect(() => {
    const handler = (event: WindowEventMap['artifact-document-close-request']) => {
      if (event.detail.panelId !== panel.id) return;
      beginCloseRequest(event.detail.tabIds);
    };
    window.addEventListener('artifact-document-close-request', handler);
    return () => window.removeEventListener('artifact-document-close-request', handler);
  }, [beginCloseRequest, panel.id]);

  const handleCancelClose = useCallback(() => {
    observeCanvasClose(pendingCloseOperationRef.current, 'cancelled');
    pendingCloseOperationRef.current = null;
    saveRequestedRef.current = null;
    closeQueue.current = [];
    const originalTabId = bulkCloseOriginalTabRef.current;
    bulkCloseOriginalTabRef.current = null;
    setWaitingForSave(false);
    setPendingCloseTab(null);
    const currentPanel = useCanvasStore.getState().panels[panel.id];
    if (
      originalTabId &&
      currentPanel &&
      currentPanel.activeTabId === pendingCloseTab?.id &&
      currentPanel.activeTabId !== originalTabId &&
      currentPanel.tabs.some((tab) => tab.id === originalTabId)
    ) {
      setActiveTab(panel.id, originalTabId);
    }
  }, [panel.id, pendingCloseTab?.id, setActiveTab]);

  const pendingTargetIsCurrent = useCallback(() => {
    const current = useCanvasStore
      .getState()
      .panels[panel.id]?.tabs.find((tab) => tab.id === pendingCloseTab?.id);
    return (
      !!current &&
      !!pendingCloseTab &&
      current.type === pendingCloseTab.type &&
      current.entityId === pendingCloseTab.entityId
    );
  }, [panel.id, pendingCloseTab]);

  useEffect(() => {
    if (
      !pendingCloseTab ||
      !saveRequestedRef.current ||
      saveTargetForTab(pendingCloseTab).kind !== 'file' ||
      pendingTargetIsCurrent()
    )
      return;
    handleCancelClose();
  }, [handleCancelClose, panel.tabs, pendingCloseTab, pendingTargetIsCurrent]);

  const handleSaveAndClose = useCallback(() => {
    if (!pendingCloseTab || saveRequestedRef.current) return;
    if (!pendingTargetIsCurrent()) {
      observeCanvasClose(pendingCloseOperationRef.current, 'refused');
      pendingCloseOperationRef.current = null;
      handleCancelClose();
      return;
    }
    const requestId = crypto.randomUUID();
    saveRequestedRef.current = requestId;
    setWaitingForSave(true);
    observeCanvasClose(pendingCloseOperationRef.current, 'save_requested');
    const target = saveTargetForTab(pendingCloseTab);
    void documentLifecycle.save(target, pendingCloseTab.id).then((success) => {
      if (saveRequestedRef.current !== requestId) return;
      const state = useCanvasStore.getState();
      const current = state.panels[panel.id]?.tabs.find((tab) => tab.id === pendingCloseTab.id);
      const ownerStillCurrent =
        target.kind === 'tab'
          ? current?.type === pendingCloseTab.type
          : current?.type === pendingCloseTab.type && current.entityId === pendingCloseTab.entityId;
      if (success && ownerStillCurrent) {
        closeTab(panel.id, pendingCloseTab.id);
        const removed = !useCanvasStore
          .getState()
          .panels[panel.id]?.tabs.some((tab) => tab.id === pendingCloseTab.id);
        observeCanvasClose(pendingCloseOperationRef.current, removed ? 'closed' : 'refused');
        pendingCloseOperationRef.current = null;
        advanceCloseQueue();
      } else if (
        success &&
        target.kind === 'tab' &&
        !Object.values(state.panels).some((candidate) =>
          candidate.tabs.some((tab) => tab.id === pendingCloseTab.id)
        )
      ) {
        observeCanvasClose(pendingCloseOperationRef.current, 'closed');
        pendingCloseOperationRef.current = null;
        advanceCloseQueue();
      } else {
        observeCanvasClose(pendingCloseOperationRef.current, 'refused');
        pendingCloseOperationRef.current = null;
        handleCancelClose();
      }
    });
  }, [
    pendingCloseTab,
    pendingTargetIsCurrent,
    handleCancelClose,
    panel.id,
    closeTab,
    advanceCloseQueue,
  ]);

  const handleDontSave = useCallback(async () => {
    if (!pendingCloseTab) return;
    if (!pendingTargetIsCurrent()) {
      observeCanvasClose(pendingCloseOperationRef.current, 'refused');
      pendingCloseOperationRef.current = null;
      handleCancelClose();
      return;
    }
    observeCanvasClose(pendingCloseOperationRef.current, 'discard_confirmed');
    const target = saveTargetForTab(pendingCloseTab);
    const requestId = crypto.randomUUID();
    saveRequestedRef.current = requestId;
    setWaitingForSave(true);
    const discarded = await documentLifecycle.discard(target, pendingCloseTab.id);
    if (saveRequestedRef.current !== requestId) return;
    if (!discarded || !pendingTargetIsCurrent()) {
      handleCancelClose();
      return;
    }
    window.dispatchEvent(
      new CustomEvent('document-discarded', {
        detail: { ...target, sourceTabId: pendingCloseTab.id },
      })
    );
    closeTab(panel.id, pendingCloseTab.id);
    const removed = !useCanvasStore
      .getState()
      .panels[panel.id]?.tabs.some((tab) => tab.id === pendingCloseTab.id);
    observeCanvasClose(pendingCloseOperationRef.current, removed ? 'closed' : 'refused');
    pendingCloseOperationRef.current = null;
    advanceCloseQueue();
  }, [
    pendingCloseTab,
    closeTab,
    panel.id,
    advanceCloseQueue,
    pendingTargetIsCurrent,
    handleCancelClose,
  ]);

  const handleReorderTab = useCallback(
    (fromIndex: number, toIndex: number) => {
      const tabId = panel.tabs[fromIndex]?.id;
      if (tabId) {
        reorderTab(panel.id, tabId, toIndex);
      }
    },
    [reorderTab, panel.id, panel.tabs]
  );

  const canCycleTabs = useCallback(() => {
    const state = useCanvasStore.getState();
    const current = state.panels[panel.id];
    return (
      pendingCloseTab === null &&
      !waitingForSave &&
      state.focusedPanelId === panel.id &&
      !!current &&
      current.tabs.length > 1 &&
      current.tabs.some((tab) => tab.id === current.activeTabId)
    );
  }, [panel.id, pendingCloseTab, waitingForSave]);

  const cycleTabs = useCallback(
    (direction: 1 | -1) => {
      if (!canCycleTabs()) return false;
      const current = useCanvasStore.getState().panels[panel.id];
      const index = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
      return handleSelectTab(
        current.tabs[(index + direction + current.tabs.length) % current.tabs.length].id
      );
    },
    [canCycleTabs, handleSelectTab, panel.id]
  );
  const nextTab = useCallback(() => cycleTabs(1), [cycleTabs]);
  const previousTab = useCallback(() => cycleTabs(-1), [cycleTabs]);
  useCommandHandler(COMMAND_IDS.canvasNextTab, nextTab, {
    enabled: canCycleTabs,
  });
  useCommandHandler(COMMAND_IDS.canvasPreviousTab, previousTab, {
    enabled: canCycleTabs,
  });

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return platform().on('window:frame-tab-navigation', ({ frameName, direction }) => {
      const frame = document.activeElement;
      if (
        !(frame instanceof HTMLIFrameElement) ||
        frame.name !== frameName ||
        !panelRef.current?.contains(frame) ||
        !presentation.owner.allowsFocus(presentation.id)
      )
        return;
      const scopes = getDebugState().activeScopes;
      if (scopes.includes(COMMAND_SCOPES.modal) || scopes.includes(COMMAND_SCOPES.menuContext))
        return;
      presentation.owner.dispatch({ type: 'focus', id: presentation.id });
      focusPanel(panel.id);
      dispatchCommand(direction === 1 ? COMMAND_IDS.canvasNextTab : COMMAND_IDS.canvasPreviousTab, {
        source: 'electron-menu',
        bypassBlockingScopes: [COMMAND_SCOPES.inputEditor],
      });
    });
  }, [dispatchCommand, focusPanel, getDebugState, panel.id, presentation]);

  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useCanvasStore.getState().focusedPanelId !== panel.id) return;
      const command = matchesAppShortcut(e, 'tabs.next')
        ? COMMAND_IDS.canvasNextTab
        : matchesAppShortcut(e, 'tabs.previous')
          ? COMMAND_IDS.canvasPreviousTab
          : null;
      if (!command || keyboardCommandBelongsToTarget(e, command, true)) return;
      const result = dispatchCommand(command, {
        source: 'keyboard',
        event: e,
        bypassBlockingScopes: [COMMAND_SCOPES.inputEditor],
      });
      if (result.handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleWindowKey = (event: KeyboardEvent) => {
      if (event.eventPhase === Event.AT_TARGET) handler(event);
    };
    presentationEvents.add(document, 'keydown', handler, true);
    presentationEvents.add(window, 'keydown', handleWindowKey);
    return () => {
      presentationEvents.remove(document, 'keydown', handler, true);
      presentationEvents.remove(window, 'keydown', handleWindowKey);
    };
  }, [dispatchCommand, isFocused, panel.id, presentationEvents]);

  useEffect(() => {
    if (!isFocused) return;
    const handler = () => {
      if (panel.activeTabId) handleCloseTab(panel.activeTabId);
    };
    window.addEventListener('waypoint:close-active-tab', handler);
    return () => window.removeEventListener('waypoint:close-active-tab', handler);
  }, [isFocused, panel.activeTabId, handleCloseTab]);

  return (
    <div
      ref={panelRef}
      onFocusCapture={documentScope.eventHandlers.onFocusCapture}
      onMouseDownCapture={documentScope.eventHandlers.onMouseDownCapture}
      className={`
        flex flex-col h-full bg-bg
        ${isFocused ? '' : ''}
      `}
    >
      <TabBar
        tabs={panel.tabs}
        activeTabId={panel.activeTabId}
        panelId={panel.id}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onReorderTab={handleReorderTab}
      />

      {}
      <div
        className="flex-1 overflow-hidden min-h-0 relative"
        data-panel-content={panel.id}
        data-tab-count={panel.tabs.length}
      >
        {activeTab ? <TabPortalTarget tab={activeTab} /> : <EmptyPanel />}
      </div>

      {}
      {pendingCloseTab && !waitingForSave && (
        <CloseConfirmationDialog
          fileName={pendingCloseTab.label}
          onSave={handleSaveAndClose}
          onDontSave={handleDontSave}
          onCancel={handleCancelClose}
          allowDontSave={!pendingCloseTab.assemblyEditDesignId}
        />
      )}
    </div>
  );
}
