import { create } from 'zustand';

interface DragState {
  isDragging: boolean;
  dragTabId: string | null;
  dragFromPanelId: string | null;
  dragTabLabel: string | null;
  dragTabType: string | null;
  dropTargetPanelId: string | null;
  dropInsertIndex: number | null;
}

interface DragActions {
  startDrag: (tabId: string, panelId: string, label: string, type: string) => void;
  setDropTarget: (panelId: string | null, insertIndex: number | null) => void;
  endDrag: () => void;
}

export const useDragStore = create<DragState & DragActions>()((set) => ({
  isDragging: false,
  dragTabId: null,
  dragFromPanelId: null,
  dragTabLabel: null,
  dragTabType: null,
  dropTargetPanelId: null,
  dropInsertIndex: null,

  startDrag: (tabId, panelId, label, type) => {
    set({
      isDragging: true,
      dragTabId: tabId,
      dragFromPanelId: panelId,
      dragTabLabel: label,
      dragTabType: type,
      dropTargetPanelId: null,
      dropInsertIndex: null,
    });
  },

  setDropTarget: (panelId, insertIndex) => {
    set({
      dropTargetPanelId: panelId,
      dropInsertIndex: insertIndex,
    });
  },

  endDrag: () => {
    set({
      isDragging: false,
      dragTabId: null,
      dragFromPanelId: null,
      dragTabLabel: null,
      dragTabType: null,
      dropTargetPanelId: null,
      dropInsertIndex: null,
    });
  },
}));
