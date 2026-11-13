import { create } from 'zustand';

interface EditorTarget {
  element: HTMLElement;
  chrome?: HTMLElement;
  active: boolean;
  visible: boolean;
  focus(): void;
}
export const useTerminalEditorTargets = create<{
  targets: Record<string, EditorTarget>;
  register(id: string, target: EditorTarget): () => void;
}>((set) => ({
  targets: {},
  register: (id, target) => {
    set((state) => ({ targets: { ...state.targets, [id]: target } }));
    return () =>
      set((state) => {
        if (state.targets[id] !== target) return state;
        const targets = { ...state.targets };
        delete targets[id];
        return { targets };
      });
  },
}));

export const TERMINAL_EDITOR_ACTION_EVENT = 'dnaforge:terminal-editor-action';
export function terminalEditorAction(
  groupId: string,
  action: 'panel' | 'split' | 'relaunch' | 'close' | 'find'
) {
  window.dispatchEvent(
    new CustomEvent(TERMINAL_EDITOR_ACTION_EVENT, { detail: { groupId, action } })
  );
}
