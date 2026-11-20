import { useEffect, useCallback, useRef } from 'react';
import { useDragStore } from '../dragStore';
import { useCanvasStore } from '../store';
import {
  createBiologyFileIconElement,
  createSpreadsheetFileIconElement,
  createTabTypeIconElement,
} from '../../../components/icons';

export type DropZone = 'center' | 'top' | 'bottom' | 'left' | 'right' | null;

const EDGE_SIZE = 80;

function calculateInsertIndex(
  mouseX: number,
  tabBarElement: HTMLElement,
  dragTabId: string
): number {
  const tabs = tabBarElement.querySelectorAll<HTMLElement>('[role="tab"]');
  for (const [index, tab] of tabs.entries()) {
    if (tab.dataset.tabId === dragTabId) continue;
    const rect = tab.getBoundingClientRect();
    if (rect.width > 0 && mouseX < rect.left + rect.width / 2) return index;
  }
  return tabs.length;
}

export function useTabDrag() {
  const isDragging = useDragStore((s) => s.isDragging);
  const dragTabId = useDragStore((s) => s.dragTabId);
  const dragFromPanelId = useDragStore((s) => s.dragFromPanelId);
  const dragTabLabel = useDragStore((s) => s.dragTabLabel);
  const dragTabType = useDragStore((s) => s.dragTabType);
  const setDropTarget = useDragStore((s) => s.setDropTarget);
  const endDrag = useDragStore((s) => s.endDrag);

  const moveTabAtIndex = useCanvasStore((s) => s.moveTabAtIndex);
  const splitAndMoveTab = useCanvasStore((s) => s.splitAndMoveTab);

  const activeZoneRef = useRef<{ zone: DropZone; panelId: string } | null>(null);
  const zoneIndicatorRef = useRef<HTMLDivElement | null>(null);
  const tabPreviewRef = useRef<HTMLDivElement | null>(null);
  const insertIndexRef = useRef<number | null>(null);

  const calculateZone = useCallback((e: MouseEvent, rect: DOMRect): DropZone => {
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    if (y < EDGE_SIZE) return 'top';
    if (y > h - EDGE_SIZE) return 'bottom';
    if (x < EDGE_SIZE) return 'left';
    if (x > w - EDGE_SIZE) return 'right';
    return 'center';
  }, []);

  const createTabPreview = useCallback((label: string, type: string) => {
    const preview = document.createElement('div');

    preview.dataset.analyticsBlock = 'true';
    preview.classList.add('ph-no-capture');
    preview.style.position = 'fixed';
    preview.style.pointerEvents = 'none';
    preview.style.zIndex = '10000';
    preview.style.display = 'flex';
    preview.style.alignItems = 'center';
    preview.style.gap = '6px';
    preview.style.padding = '6px 12px';
    preview.style.backgroundColor = 'var(--color-bg, #1f2937)';
    preview.style.border = '1px solid var(--color-border, #374151)';
    preview.style.borderRadius = '6px';
    preview.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    preview.style.fontSize = '13px';
    preview.style.color = 'var(--color-fg, #f9fafb)';
    preview.style.fontFamily = 'inherit';
    preview.style.whiteSpace = 'nowrap';
    preview.style.transform = 'translate(-50%, -100%)';
    preview.style.marginTop = '-8px';

    const icon = document.createElement('span');
    icon.style.display = 'inline-flex';
    icon.style.alignItems = 'center';
    icon.style.color = 'currentColor';
    if (type === 'sequence') {
      icon.appendChild(createBiologyFileIconElement(14));
    } else if (type === 'table') {
      icon.appendChild(createSpreadsheetFileIconElement(14));
    } else {
      const iconEl = createTabTypeIconElement(type, 14) ?? createTabTypeIconElement('file', 14);
      if (iconEl) icon.appendChild(iconEl);
    }

    const text = document.createElement('span');
    text.textContent = label;
    text.style.maxWidth = '150px';
    text.style.overflow = 'hidden';
    text.style.textOverflow = 'ellipsis';

    preview.appendChild(icon);
    preview.appendChild(text);

    document.body.appendChild(preview);
    return preview;
  }, []);

  const updateTabPreview = useCallback((e: MouseEvent) => {
    if (tabPreviewRef.current) {
      tabPreviewRef.current.style.left = `${e.clientX}px`;
      tabPreviewRef.current.style.top = `${e.clientY}px`;
    }
  }, []);

  const updateOverlay = useCallback((panelElement: HTMLElement | null, zone: DropZone) => {
    if (zoneIndicatorRef.current) {
      zoneIndicatorRef.current.remove();
      zoneIndicatorRef.current = null;
    }

    if (!panelElement || !zone) return;

    const rect = panelElement.getBoundingClientRect();

    const indicator = document.createElement('div');
    indicator.style.position = 'fixed';
    indicator.style.pointerEvents = 'none';
    indicator.style.zIndex = '9999';
    indicator.style.backgroundColor = 'rgba(59, 130, 246, 0.3)';
    indicator.style.border = '2px solid rgb(59, 130, 246)';
    indicator.style.borderRadius = '4px';
    indicator.style.transition = 'all 0.1s ease';

    switch (zone) {
      case 'top':
        indicator.style.left = `${rect.left + 4}px`;
        indicator.style.top = `${rect.top + 4}px`;
        indicator.style.width = `${rect.width - 8}px`;
        indicator.style.height = `${rect.height / 2 - 8}px`;
        break;
      case 'bottom':
        indicator.style.left = `${rect.left + 4}px`;
        indicator.style.top = `${rect.top + rect.height / 2 + 4}px`;
        indicator.style.width = `${rect.width - 8}px`;
        indicator.style.height = `${rect.height / 2 - 8}px`;
        break;
      case 'left':
        indicator.style.left = `${rect.left + 4}px`;
        indicator.style.top = `${rect.top + 4}px`;
        indicator.style.width = `${rect.width / 2 - 8}px`;
        indicator.style.height = `${rect.height - 8}px`;
        break;
      case 'right':
        indicator.style.left = `${rect.left + rect.width / 2 + 4}px`;
        indicator.style.top = `${rect.top + 4}px`;
        indicator.style.width = `${rect.width / 2 - 8}px`;
        indicator.style.height = `${rect.height - 8}px`;
        break;
      case 'center':
        indicator.style.left = `${rect.left + 4}px`;
        indicator.style.top = `${rect.top + 4}px`;
        indicator.style.width = `${rect.width - 8}px`;
        indicator.style.height = `${rect.height - 8}px`;
        indicator.style.borderStyle = 'dashed';
        indicator.style.backgroundColor = 'rgba(59, 130, 246, 0.15)';
        break;
    }

    document.body.appendChild(indicator);
    zoneIndicatorRef.current = indicator;
  }, []);

  const _updateOverlayForTabBar = useCallback((tabBarElement: HTMLElement) => {
    if (zoneIndicatorRef.current) {
      zoneIndicatorRef.current.remove();
      zoneIndicatorRef.current = null;
    }

    const rect = tabBarElement.getBoundingClientRect();

    const indicator = document.createElement('div');
    indicator.style.position = 'fixed';
    indicator.style.pointerEvents = 'none';
    indicator.style.zIndex = '9999';
    indicator.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
    indicator.style.border = '2px solid rgb(59, 130, 246)';
    indicator.style.borderRadius = '4px';
    indicator.style.left = `${rect.left}px`;
    indicator.style.top = `${rect.top}px`;
    indicator.style.width = `${rect.width}px`;
    indicator.style.height = `${rect.height}px`;

    document.body.appendChild(indicator);
    zoneIndicatorRef.current = indicator;
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !dragTabId || !dragFromPanelId) return;

      updateTabPreview(e);

      const tabBars = document.querySelectorAll('[data-tab-bar]');
      for (const tabBar of tabBars) {
        const rect = tabBar.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          const targetPanelId = tabBar.getAttribute('data-tab-bar');
          if (targetPanelId) {
            const insertIndex = calculateInsertIndex(e.clientX, tabBar as HTMLElement, dragTabId);

            setDropTarget(targetPanelId, insertIndex);

            activeZoneRef.current = { zone: 'center', panelId: targetPanelId };
            insertIndexRef.current = insertIndex;

            updateOverlay(null, null);
            return;
          }
        }
      }

      setDropTarget(null, null);
      insertIndexRef.current = null;

      const panels = document.querySelectorAll('[data-panel-content]');
      let targetPanel: HTMLElement | null = null;
      let targetPanelId: string | null = null;

      for (const panel of panels) {
        const rect = panel.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          targetPanel = panel as HTMLElement;
          targetPanelId = panel.getAttribute('data-panel-content');
          break;
        }
      }

      if (targetPanel && targetPanelId) {
        const rect = targetPanel.getBoundingClientRect();
        const zone = calculateZone(e, rect);

        const tabCount = parseInt(targetPanel.getAttribute('data-tab-count') || '0', 10);
        const isSamePanel = dragFromPanelId === targetPanelId;
        const isOnlyTab = tabCount === 1;

        if (isSamePanel && isOnlyTab && zone !== 'center') {
          activeZoneRef.current = null;
          updateOverlay(null, null);
          return;
        }

        activeZoneRef.current = { zone, panelId: targetPanelId };
        updateOverlay(targetPanel, zone);
      } else {
        activeZoneRef.current = null;
        updateOverlay(null, null);
      }
    },
    [
      isDragging,
      dragTabId,
      dragFromPanelId,
      calculateZone,
      updateOverlay,
      updateTabPreview,
      setDropTarget,
    ]
  );

  const handleMouseUp = useCallback(() => {
    if (!isDragging || !dragTabId || !dragFromPanelId) {
      endDrag();
      return;
    }

    const activeZone = activeZoneRef.current;
    const insertIndex = insertIndexRef.current;

    if (zoneIndicatorRef.current) {
      zoneIndicatorRef.current.remove();
      zoneIndicatorRef.current = null;
    }
    if (tabPreviewRef.current) {
      tabPreviewRef.current.remove();
      tabPreviewRef.current = null;
    }

    if (activeZone && activeZone.zone) {
      const { zone, panelId: targetPanelId } = activeZone;

      console.log('[useTabDrag] Dropping:', {
        zone,
        targetPanelId,
        dragFromPanelId,
        dragTabId,
        insertIndex,
      });

      if (zone === 'center') {
        let destination = insertIndex;
        if (dragFromPanelId === targetPanelId && destination !== null) {
          const sourcePanel = useCanvasStore.getState().panels[dragFromPanelId];
          const sourceIndex = sourcePanel?.tabs.findIndex((tab) => tab.id === dragTabId) ?? -1;
          if (sourceIndex >= 0 && sourceIndex < destination) destination--;
        }
        moveTabAtIndex(dragFromPanelId, targetPanelId, dragTabId, destination);
      } else {
        const directionMap = {
          top: 'up',
          bottom: 'down',
          left: 'left',
          right: 'right',
        } as const;
        splitAndMoveTab(targetPanelId, directionMap[zone], dragFromPanelId, dragTabId);
      }
    }

    activeZoneRef.current = null;
    insertIndexRef.current = null;
    endDrag();
  }, [isDragging, dragTabId, dragFromPanelId, endDrag, moveTabAtIndex, splitAndMoveTab]);

  useEffect(() => {
    if (isDragging && dragTabLabel && dragTabType) {
      tabPreviewRef.current = createTabPreview(dragTabLabel, dragTabType);

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      document.body.classList.add('dragging-tab');

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.classList.remove('dragging-tab');

        if (zoneIndicatorRef.current) {
          zoneIndicatorRef.current.remove();
          zoneIndicatorRef.current = null;
        }
        if (tabPreviewRef.current) {
          tabPreviewRef.current.remove();
          tabPreviewRef.current = null;
        }
      };
    }
  }, [isDragging, dragTabLabel, dragTabType, handleMouseMove, handleMouseUp, createTabPreview]);

  return { isDragging };
}
