import { create } from 'zustand';
import { useSequenceStore } from '../features/sequence/public/store';

interface SequenceEditModeStore {
  active: boolean;
  setActive: (active: boolean) => void;
  editRequest: { entityId: string; requestId: number } | null;
  requestEdit: (entityId: string) => void;
  consumeEditRequest: (requestId: number) => void;
}

let nextEditRequestId = 1;

export const useSequenceEditModeStore = create<SequenceEditModeStore>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
  editRequest: null,
  requestEdit: (entityId) => {
    if (useSequenceStore.getState().isLoading(entityId)) return;
    set({
      editRequest: {
        entityId,
        requestId: nextEditRequestId++,
      },
    });
  },
  consumeEditRequest: (requestId) =>
    set((state) => (state.editRequest?.requestId === requestId ? { editRequest: null } : state)),
}));
