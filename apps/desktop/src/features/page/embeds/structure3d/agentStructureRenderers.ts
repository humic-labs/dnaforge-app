import { createContext, useContext } from 'react';
import { create } from 'zustand';

export const AGENT_STRUCTURE_RENDERER_BUDGET = 2;
export const AGENT_STRUCTURE_RENDERER_IDLE_MS = 60_000;

export const useAgentStructureRenderers = create<{ tabIds: readonly string[] }>(() => ({
  tabIds: [],
}));

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearIdleTimer(tabId: string): void {
  const timer = idleTimers.get(tabId);
  if (timer) clearTimeout(timer);
  idleTimers.delete(tabId);
}

export function agentStructureRendererHostId(tabId: string): string {
  return `agent:${tabId}`;
}

export function hasAgentStructureRenderer(tabId: string): boolean {
  return useAgentStructureRenderers.getState().tabIds.includes(tabId);
}

export function leaseAgentStructureRenderer(tabId: string): void {
  clearIdleTimer(tabId);
  idleTimers.set(
    tabId,
    setTimeout(() => releaseAgentStructureRenderer(tabId), AGENT_STRUCTURE_RENDERER_IDLE_MS)
  );
  const current = useAgentStructureRenderers.getState().tabIds;
  if (current[current.length - 1] === tabId) return;
  const next = [...current.filter((id) => id !== tabId), tabId];
  const evicted = next.splice(0, Math.max(0, next.length - AGENT_STRUCTURE_RENDERER_BUDGET));
  evicted.forEach(clearIdleTimer);
  useAgentStructureRenderers.setState({ tabIds: next });
}

export function releaseAgentStructureRenderer(tabId: string): void {
  clearIdleTimer(tabId);
  const current = useAgentStructureRenderers.getState().tabIds;
  if (current.includes(tabId))
    useAgentStructureRenderers.setState({ tabIds: current.filter((id) => id !== tabId) });
}

const StructureRendererHostOverride = createContext<string | null>(null);

export const StructureRendererHostProvider = StructureRendererHostOverride.Provider;

export function useStructureRendererHostId(paneHostId: string | undefined): string | undefined {
  return useContext(StructureRendererHostOverride) ?? paneHostId;
}
