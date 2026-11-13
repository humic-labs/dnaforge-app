import { create } from 'zustand';
import type { TabularImportEntry } from './tabular-import';

interface TabularImportRequest {
  entries: TabularImportEntry[];
  resolve: (confirmed: TabularImportEntry[] | null) => void;
}

interface TabularImportStore {
  request: TabularImportRequest | null;
  openTabularImportWizard: (entries: TabularImportEntry[]) => Promise<TabularImportEntry[] | null>;
  resolveCurrent: (confirmed: TabularImportEntry[] | null) => void;
}

export const useTabularImportStore = create<TabularImportStore>((set, get) => ({
  request: null,

  openTabularImportWizard: (entries) =>
    new Promise<TabularImportEntry[] | null>((resolve) => {
      const prev = get().request;
      if (prev) prev.resolve(null);
      set({ request: { entries, resolve } });
    }),

  resolveCurrent: (confirmed) => {
    const current = get().request;
    if (!current) return;
    set({ request: null });
    current.resolve(confirmed);
  },
}));

export function openTabularImportWizard(
  entries: TabularImportEntry[]
): Promise<TabularImportEntry[] | null> {
  return useTabularImportStore.getState().openTabularImportWizard(entries);
}
