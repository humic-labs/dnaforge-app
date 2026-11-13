import { create } from 'zustand';

export const useAdvancedSettingsDrawerState = create<{
  open: Record<string, true>;
  setOpen: (viewerInstanceId: string, open: boolean) => void;
}>()((set) => ({
  open: {},
  setOpen: (viewerInstanceId, open) =>
    set((state) => {
      const next = { ...state.open };
      if (open) next[viewerInstanceId] = true;
      else delete next[viewerInstanceId];
      return { open: next };
    }),
}));
