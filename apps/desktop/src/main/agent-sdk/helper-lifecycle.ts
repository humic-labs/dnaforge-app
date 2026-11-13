import type { AgentHelperLifecycleSnapshot } from '../../shared/agent-helper-lifecycle';

export interface AgentHelperLifecycleTracker {
  readonly track: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly snapshot: () => AgentHelperLifecycleSnapshot;
}

export function createAgentHelperLifecycleTracker(): AgentHelperLifecycleTracker {
  let active = 0;
  let started = 0;
  let settled = 0;
  let peakActive = 0;

  const track = async <T>(operation: () => Promise<T>): Promise<T> => {
    started += 1;
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      return await operation();
    } finally {
      active -= 1;
      settled += 1;
    }
  };

  const snapshot = (): AgentHelperLifecycleSnapshot => ({
    active,
    started,
    settled,
    peakActive,
  });

  return { track, snapshot };
}

const agentHelperLifecycle = createAgentHelperLifecycleTracker();

export const trackAgentHelperOperation = agentHelperLifecycle.track;
export const getAgentHelperLifecycleSnapshot = agentHelperLifecycle.snapshot;
