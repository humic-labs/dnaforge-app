import { create } from 'zustand';
export const useNotebookConflictStore = create<{
  documentId: string | null;
  open(documentId: string): void;
  close(): void;
}>((set) => ({
  documentId: null,
  open: (documentId) => set({ documentId }),
  close: () => set({ documentId: null }),
}));
