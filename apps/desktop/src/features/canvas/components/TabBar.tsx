import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { Tab } from './Tab';
import { TabContextMenu } from './TabContextMenu';
import { TabBarContextMenu } from './TabBarContextMenu';
import { useDragStore } from '../dragStore';
import { useCanvasStore } from '../store';
import { usePageStore } from '../../page/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useGitStatus } from '../../../hooks/useGitStatus';
import type { GitFileStatus } from '../../workspace/public/git';
import type { Tab as TabType } from '../types';
import { pathRelativeToBoundary } from '../../../shared/path-boundary';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import { soleWritableProjectRoot } from '../../../shared/project-root-selection';
import { CanvasTabStrip } from './CanvasTabStrip';
import { requestManagedSequenceRename } from '../../sequence/public/managed-sequence-rename';
import { projectTabStripTab } from '../tab-menu-presentation';
import { useSequenceStore } from '../../sequence/public/store';
import { sequenceDocumentKey } from '../../../shared/managed-sequence-document';

const INSERT_GAP_WIDTH = 80;

interface TabBarProps {
  tabs: TabType[];
  activeTabId: string | null;
  panelId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReorderTab?: (fromIndex: number, toIndex: number) => void;
}

export const TabBar = React.memo(function TabBar({
  tabs,
  activeTabId,
  panelId,
  onSelectTab,
  onCloseTab,
  onReorderTab,
}: TabBarProps) {
  useSequenceStore((state) =>
    tabs
      .map((tab) =>
        tab.sequenceDocument
          ? (state.sequences[sequenceDocumentKey(tab.sequenceDocument)]?.molecule ?? '')
          : ''
      )
      .join('|')
  );
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    position: { x: number; y: number };
  } | null>(null);
  const [tabBarContextMenu, setTabBarContextMenu] = useState<{
    position: { x: number; y: number };
  } | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);

  const isDragging = useDragStore((s) => s.isDragging);
  const dropTargetPanelId = useDragStore((s) => s.dropTargetPanelId);
  const dropInsertIndex = useDragStore((s) => s.dropInsertIndex);
  const dragTabId = useDragStore((s) => s.dragTabId);

  const updateTab = useCanvasStore((s) => s.updateTab);
  const renamePageArtifact = usePageStore((s) => s.renamePageArtifact);

  const folders = useWorkspaceStore((s) => s.folders);
  const activeEntityPath = tabs.find((tab) => tab.id === activeTabId)?.entityId ?? null;
  const projectPath =
    (activeEntityPath ? findContainingPathBoundary(folders, activeEntityPath)?.path : null) ??
    soleWritableProjectRoot(folders)?.path ??
    null;
  const { statusMap: gitStatusMap } = useGitStatus(projectPath);

  const getTabGitStatus = useCallback(
    (entityId: string): GitFileStatus | undefined => {
      if (!projectPath || !gitStatusMap.size) return undefined;
      const rel = pathRelativeToBoundary(entityId, projectPath);
      if (rel) {
        return gitStatusMap.get(rel);
      }
      return undefined;
    },
    [projectPath, gitStatusMap]
  );

  const handleStartRename = useCallback((tabId: string) => {
    setEditingTabId(tabId);
  }, []);

  const handleRenameManagedSequence = useCallback(
    (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      const documentRef = tab?.sequenceDocument;
      if (!documentRef || documentRef.kind !== 'managed-sequence') return;
      requestManagedSequenceRename(documentRef.packageId);
    },
    [tabs]
  );

  const handleRename = useCallback(
    (tabId: string, newLabel: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) {
        setEditingTabId(null);
        return;
      }

      void (async () => {
        if (tab.type === 'page' && tab.entityId) {
          try {
            const artifact = await renamePageArtifact(tab.entityId, newLabel);
            const effectiveLabel = usePageStore.getState().pages[tab.entityId]?.title ?? newLabel;
            updateTab(panelId, tabId, { label: effectiveLabel });
            if (artifact) {
              window.dispatchEvent(
                new CustomEvent('waypoint:workspace-files-changed', {
                  detail: { path: artifact.path },
                })
              );
            }
          } catch (err) {
            console.warn('[TabBar] Failed to rename backing notebook artifact:', err);
            return;
          }
        } else {
          updateTab(panelId, tabId, { label: newLabel });
        }
        setEditingTabId(null);
      })();
    },
    [panelId, renamePageArtifact, tabs, updateTab]
  );

  const handleCancelRename = useCallback(() => {
    setEditingTabId(null);
  }, []);

  const showTrailingGap = useMemo(() => {
    if (!isDragging || dropTargetPanelId !== panelId || dropInsertIndex === null) {
      return false;
    }
    const isAtEnd = dropInsertIndex >= tabs.length;
    const draggedTabInThisPanel = tabs.some((t) => t.id === dragTabId);
    if (draggedTabInThisPanel) {
      return dropInsertIndex >= tabs.length - 1;
    }
    return isAtEnd;
  }, [isDragging, dropTargetPanelId, panelId, dropInsertIndex, tabs, dragTabId]);

  useEffect(() => {
    if (isDragging) {
      if (contextMenu) setContextMenu(null);
      if (tabBarContextMenu) setTabBarContextMenu(null);
      if (editingTabId) setEditingTabId(null);
    }
  }, [isDragging, contextMenu, tabBarContextMenu, editingTabId]);

  const handleContextMenu = useCallback((tabId: string, position: { x: number; y: number }) => {
    setTabBarContextMenu(null);
    setContextMenu({ tabId, position });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleTabBarContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu(null);
    setTabBarContextMenu({ position: { x: e.clientX, y: e.clientY } });
  }, []);

  const handleCloseTabBarContextMenu = useCallback(() => {
    setTabBarContextMenu(null);
  }, []);

  const activeIndex = useMemo(
    () => tabs.findIndex((t) => t.id === activeTabId),
    [tabs, activeTabId]
  );

  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeTabId) return;
    const el = strip.querySelector<HTMLElement>(`[data-testid="tab-${CSS.escape(activeTabId)}"]`);
    if (!el) return;
    const tabBox = el.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    if (tabBox.left >= stripBox.left && tabBox.right <= stripBox.right) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <CanvasTabStrip
      panelId={panelId}
      stripRef={stripRef}
      onContextMenu={handleTabBarContextMenu}
      trailing={
        <>
          {contextMenu && (
            <TabContextMenu
              position={contextMenu.position}
              tabId={contextMenu.tabId}
              panelId={panelId}
              onClose={handleCloseContextMenu}
              onSelectTab={onSelectTab}
              onStartRename={handleStartRename}
              onRenameManagedSequence={handleRenameManagedSequence}
            />
          )}

          {tabBarContextMenu && (
            <TabBarContextMenu
              position={tabBarContextMenu.position}
              panelId={panelId}
              onClose={handleCloseTabBarContextMenu}
            />
          )}
        </>
      }
    >
      {tabs.map((tab, index) => (
        <Tab
          key={tab.id}
          tab={projectTabStripTab(tab)}
          panelId={panelId}
          index={index}
          isActive={tab.id === activeTabId}
          isBeforeActive={activeIndex > 0 && index === activeIndex - 1}
          isAfterActive={activeIndex >= 0 && index === activeIndex + 1}
          isEditing={editingTabId === tab.id}
          gitStatus={getTabGitStatus(tab.entityId)}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onReorder={onReorderTab}
          onContextMenu={handleContextMenu}
          onStartRename={handleStartRename}
          onRename={handleRename}
          onCancelRename={handleCancelRename}
        />
      ))}
      {}
      {showTrailingGap && (
        <div
          style={{
            width: `${INSERT_GAP_WIDTH}px`,
            transition: 'width 150ms ease-out',
          }}
          className="flex-shrink-0"
        />
      )}
    </CanvasTabStrip>
  );
});
