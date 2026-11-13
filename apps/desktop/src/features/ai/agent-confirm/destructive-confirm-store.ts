import { create } from 'zustand';

import type { DestructiveFileConfirmRequest } from '../../../shared/agent-confirm-types';

interface DestructiveConfirmStore {
  request: DestructiveFileConfirmRequest | null;
  present: (request: DestructiveFileConfirmRequest) => void;
  clear: () => void;
}

export const useDestructiveConfirmStore = create<DestructiveConfirmStore>((set) => ({
  request: null,
  present: (request) => set({ request }),
  clear: () => set({ request: null }),
}));
