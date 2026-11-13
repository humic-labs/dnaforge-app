import type { SelectionRange } from '../selection-state';

export function createSequenceSelectionPreviewStore() {
  let current: SelectionRange | null | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => current,
    set(range: SelectionRange | null | undefined) {
      if (
        current === range ||
        (current &&
          range &&
          current.start === range.start &&
          current.end === range.end &&
          current.wraps === range.wraps)
      )
        return;
      current = range;
      for (const listener of listeners) listener();
    },
  };
}

export type SequenceSelectionPreviewStore = ReturnType<typeof createSequenceSelectionPreviewStore>;
