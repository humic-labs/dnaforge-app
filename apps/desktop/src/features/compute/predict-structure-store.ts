import { create } from 'zustand';

export interface PredictStructureTarget {
  sequence: string;
  name: string;
  preferredRoot: string | null;
  inspectionTarget?: { document_id: string; protein_key: string };
}

interface PredictStructureState {
  target: PredictStructureTarget | null;
  open(target: PredictStructureTarget): void;
  close(): void;
}

export const usePredictStructureStore = create<PredictStructureState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
