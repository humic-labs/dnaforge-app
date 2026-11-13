import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useStructureViewerPreferences = create<{
  showSequenceByDefault: boolean;
  setShowSequenceByDefault: (visible: boolean) => void;
}>()(
  persist(
    (set) => ({
      showSequenceByDefault: true,
      setShowSequenceByDefault: (showSequenceByDefault) => set({ showSequenceByDefault }),
    }),
    {
      name: 'dnaforge:structure-viewer-preferences',
      version: 1,
      migrate: () => ({ showSequenceByDefault: true }),
      partialize: ({ showSequenceByDefault }) => ({ showSequenceByDefault }),
      merge: (saved, current) => {
        const stored = saved as { showSequenceByDefault?: unknown };
        return {
          ...current,
          showSequenceByDefault:
            typeof stored?.showSequenceByDefault === 'boolean'
              ? stored.showSequenceByDefault
              : current.showSequenceByDefault,
        };
      },
    }
  )
);
