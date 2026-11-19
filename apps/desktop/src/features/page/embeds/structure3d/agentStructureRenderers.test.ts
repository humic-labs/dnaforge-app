import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireAgentStructureRenderer,
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

  it('never evicts a renderer that is running a command and waits for a free one', async () => {
    const releaseA = await acquireAgentStructureRenderer('a');
    const releaseB = await acquireAgentStructureRenderer('b');
    let releaseC: (() => void) | null = null;
    const waiting = acquireAgentStructureRenderer('c').then((release) => (releaseC = release));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(releaseC).toBeNull();
    expect(useAgentStructureRenderers.getState().tabIds).toEqual(['a', 'b']);

    releaseA!();
    await waiting;
    expect(releaseC).toEqual(expect.any(Function));
    expect(useAgentStructureRenderers.getState().tabIds).toEqual(['b', 'c']);
    releaseB!();
    releaseC!();
  });

  it('gives up waiting when every renderer stays busy', async () => {
    const releaseA = await acquireAgentStructureRenderer('a');
    const releaseB = await acquireAgentStructureRenderer('b');
    const waiting = acquireAgentStructureRenderer('c', 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await waiting).toBeNull();
    expect(hasAgentStructureRenderer('c')).toBe(false);
    releaseA!();
    releaseB!();
  });

  it('keeps a busy renderer past its idle time', async () => {
    const release = await acquireAgentStructureRenderer('a');
    vi.advanceTimersByTime(AGENT_STRUCTURE_RENDERER_IDLE_MS * 2);
    expect(hasAgentStructureRenderer('a')).toBe(true);
    release!();
    vi.advanceTimersByTime(AGENT_STRUCTURE_RENDERER_IDLE_MS);
    expect(hasAgentStructureRenderer('a')).toBe(false);
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
