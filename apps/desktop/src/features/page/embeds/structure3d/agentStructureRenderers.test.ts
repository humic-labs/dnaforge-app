import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_STRUCTURE_RENDERER_BUDGET,
  AGENT_STRUCTURE_RENDERER_IDLE_MS,
  hasAgentStructureRenderer,
  leaseAgentStructureRenderer,
  releaseAgentStructureRenderer,
  useAgentStructureRenderers,
} from './agentStructureRenderers';

describe('agent structure renderers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAgentStructureRenderers.setState({ tabIds: [] });
  });

  afterEach(() => {
    for (const tabId of useAgentStructureRenderers.getState().tabIds)
      releaseAgentStructureRenderer(tabId);
    vi.useRealTimers();
  });

  it('keeps at most the budgeted renderers and releases the least recently used one', () => {
    expect(AGENT_STRUCTURE_RENDERER_BUDGET).toBe(2);
    leaseAgentStructureRenderer('a');
    leaseAgentStructureRenderer('b');
    leaseAgentStructureRenderer('a');
    leaseAgentStructureRenderer('c');
    expect(useAgentStructureRenderers.getState().tabIds).toEqual(['a', 'c']);
    expect(hasAgentStructureRenderer('b')).toBe(false);
  });

  it('releases a renderer after it sits idle and extends the lease on each use', () => {
    leaseAgentStructureRenderer('a');
    vi.advanceTimersByTime(AGENT_STRUCTURE_RENDERER_IDLE_MS - 1);
    leaseAgentStructureRenderer('a');
    vi.advanceTimersByTime(AGENT_STRUCTURE_RENDERER_IDLE_MS - 1);
    expect(hasAgentStructureRenderer('a')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hasAgentStructureRenderer('a')).toBe(false);
  });
});
