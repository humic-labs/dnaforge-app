import { create } from 'zustand';

export type CreatableEntityType = 'strains' | 'registry-types';

export interface EntityCreationRequest {
  entityType: CreatableEntityType;
  destinationPath: string;
}

interface EntityCreationStore {
  request: EntityCreationRequest | null;
  open: (request: EntityCreationRequest) => void;
  close: () => void;
}

export const useEntityCreationStore = create<EntityCreationStore>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function openEntityCreation(request: EntityCreationRequest): void {
  useEntityCreationStore.getState().open(request);
}
