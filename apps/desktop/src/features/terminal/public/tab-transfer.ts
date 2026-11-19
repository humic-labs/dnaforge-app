import type { DragEventHandler } from 'react';
import { TERMINAL_DRAG_TYPE } from '../terminal-layout';

export type TerminalTabTransfer =
  | { target: 'editor'; sessionId: string; panelId: string }
  | { target: 'sidebar'; viewId: string };

export const TERMINAL_TAB_TRANSFER_EVENT = 'dnaforge:transfer-terminal-tab';

export function transferTerminalTab(detail: TerminalTabTransfer) {
  window.dispatchEvent(new CustomEvent(TERMINAL_TAB_TRANSFER_EVENT, { detail }));
}

export function terminalTabDropTarget(panelId: string): {
  onDragOver: DragEventHandler;
  onDrop: DragEventHandler;
} {
  return {
    onDragOver(event) {
      if (!event.dataTransfer.types.includes(TERMINAL_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDrop(event) {
      const sessionId = event.dataTransfer.getData(TERMINAL_DRAG_TYPE);
      if (!sessionId) return;
      event.preventDefault();
      event.stopPropagation();
      transferTerminalTab({ target: 'editor', sessionId, panelId });
    },
  };
}
