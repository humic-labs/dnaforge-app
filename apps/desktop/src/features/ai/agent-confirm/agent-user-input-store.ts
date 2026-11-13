import { create } from 'zustand';

import type { AgentUserInputRequest } from '../../../shared/agent-confirm-types';

interface AgentUserInputStore {
  request: AgentUserInputRequest | null;
  present: (request: AgentUserInputRequest) => void;
  clear: () => void;
}

export const useAgentUserInputStore = create<AgentUserInputStore>((set) => ({
  request: null,
  present: (request) => set({ request }),
  clear: () => set({ request: null }),
}));
