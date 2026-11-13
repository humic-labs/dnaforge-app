import { create } from 'zustand';
import type { ImportItem, ImportWizardState } from '../workspace-loader/public/import-wizard-state';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';

export interface ImportWizardOutcome {
  items: ImportItem[];
  destination: ImportDestination;
  importIntent?: ImportWizardState['importIntent'];
  agentRequested: boolean;
}

interface ImportWizardRequest {
  readonly id: string;
  phase: 'reviewing' | 'confirmed' | 'cancelled' | 'superseded';
  initial: ImportWizardState;
  resolve: (outcome: ImportWizardOutcome | null) => void;
}

interface ImportWizardStore {
  request: ImportWizardRequest | null;
  openImportWizard: (initial: ImportWizardState) => Promise<ImportWizardOutcome | null>;
  resolveCurrent: (outcome: ImportWizardOutcome | null, requestId?: string) => void;
}

export const useImportWizardStore = create<ImportWizardStore>((set, get) => ({
  request: null,

  openImportWizard: (initial) =>
    new Promise<ImportWizardOutcome | null>((resolve) => {
      const prev = get().request;
      const request: ImportWizardRequest = {
        id: crypto.randomUUID(),
        phase: 'reviewing',
        initial,
        resolve,
      };
      set({ request });
      if (prev) {
        prev.phase = 'superseded';
        prev.resolve(null);
      }
    }),

  resolveCurrent: (outcome, requestId) => {
    const current = get().request;
    if (!current || current.phase !== 'reviewing' || (requestId && current.id !== requestId))
      return;
    current.phase = outcome ? 'confirmed' : 'cancelled';
    set({ request: null });
    current.resolve(outcome);
  },
}));

export function openImportWizard(initial: ImportWizardState): Promise<ImportWizardOutcome | null> {
  return useImportWizardStore.getState().openImportWizard(initial);
}
