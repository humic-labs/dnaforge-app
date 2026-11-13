import { create } from 'zustand';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';

export interface TranslationDialogRequest {
  sequence: string;
  label?: string;
  geneticCode?: GeneticCodeSpec;
}

interface TranslationDialogStore {
  request: TranslationDialogRequest | null;
  requestRevision: number;
  open: (request: TranslationDialogRequest) => void;
  close: () => void;
}

export const useTranslationDialogStore = create<TranslationDialogStore>((set) => ({
  request: null,
  requestRevision: 0,
  open: (request) => set((state) => ({ request, requestRevision: state.requestRevision + 1 })),
  close: () => set({ request: null }),
}));
