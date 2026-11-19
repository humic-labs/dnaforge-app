import { createContext, useContext } from 'react';
import { create } from 'zustand';

export const AGENT_STRUCTURE_RENDERER_BUDGET = 2;
export const AGENT_STRUCTURE_RENDERER_IDLE_MS = 60_000;
export const AGENT_STRUCTURE_RENDERER_WAIT_MS = 60_000;

export const useAgentStructureRenderers = create<{ tabIds: readonly string[] }>(() => ({
  tabIds: [],
}));

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const commandsInFlight = new Map<string, number>();
const waiters = new Set<() => void>();

function clearIdleTimer(tabId: string): void {
  const timer = idleTimers.get(tabId);
  if (timer) clearTimeout(timer);
  idleTimers.delete(tabId);
}

function scheduleIdleRelease(tabId: string): void {
  clearIdleTimer(tabId);
  idleTimers.set(
    tabId,
    setTimeout(() => {
      idleTimers.delete(tabId);
      if (commandsInFlight.get(tabId)) scheduleIdleRelease(tabId);
      else releaseAgentStructureRenderer(tabId);
    }, AGENT_STRUCTURE_RENDERER_IDLE_MS)
  );
}

function wakeWaiters(): void {
  for (const wake of [...waiters]) wake();
}

function tryLease(tabId: string): boolean {
  const current = useAgentStructureRenderers.getState().tabIds;
  if (current.includes(tabId)) {
    if (current[current.length - 1] !== tabId)
      useAgentStructureRenderers.setState({
        tabIds: [...current.filter((id) => id !== tabId), tabId],
      });
    return true;
  }
  const next = [...current];
  while (next.length >= AGENT_STRUCTURE_RENDERER_BUDGET) {
    const idle = next.find((id) => !commandsInFlight.get(id));
    if (!idle) return false;
    next.splice(next.indexOf(idle), 1);
    clearIdleTimer(idle);
  }
  useAgentStructureRenderers.setState({ tabIds: [...next, tabId] });
  return true;
}

export function agentStructureRendererHostId(tabId: string): string {
  return `agent:${tabId}`;
}

export function hasAgentStructureRenderer(tabId: string): boolean {
  return useAgentStructureRenderers.getState().tabIds.includes(tabId);
}

export function leaseAgentStructureRenderer(tabId: string): boolean {
  const leased = tryLease(tabId);
  if (leased) scheduleIdleRelease(tabId);
  return leased;
}

export async function acquireAgentStructureRenderer(
  tabId: string,
  waitMs: number = AGENT_STRUCTURE_RENDERER_WAIT_MS
): Promise<(() => void) | null> {
  const deadline = Date.now() + waitMs;
  while (!tryLease(tabId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>((resolve) => {
      const wake = () => {
        waiters.delete(wake);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(wake, remaining);
      waiters.add(wake);
    });
  }
  commandsInFlight.set(tabId, (commandsInFlight.get(tabId) ?? 0) + 1);
  scheduleIdleRelease(tabId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (commandsInFlight.get(tabId) ?? 1) - 1;
    if (remaining > 0) commandsInFlight.set(tabId, remaining);
    else commandsInFlight.delete(tabId);
    if (hasAgentStructureRenderer(tabId)) scheduleIdleRelease(tabId);
    wakeWaiters();
  };
}

export function releaseAgentStructureRenderer(tabId: string): void {
  clearIdleTimer(tabId);
  const current = useAgentStructureRenderers.getState().tabIds;
  if (current.includes(tabId))
    useAgentStructureRenderers.setState({ tabIds: current.filter((id) => id !== tabId) });
  wakeWaiters();
}

const StructureRendererHostOverride = createContext<string | null>(null);

export const StructureRendererHostProvider = StructureRendererHostOverride.Provider;

export function useStructureRendererHostId(paneHostId: string | undefined): string | undefined {
  return useContext(StructureRendererHostOverride) ?? paneHostId;
}
