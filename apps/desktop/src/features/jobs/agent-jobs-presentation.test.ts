// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  projectAgentJobsSnapshot,
  type AgentJobsPresentationSource,
} from './agent-jobs-presentation';
import { canRequestJobStop } from './presentation';

const NOW = Date.UTC(2026, 8, 16, 8, 0, 0);

function source(overrides: Partial<AgentJobsPresentationSource> = {}): AgentJobsPresentationSource {
  return {
    jobs: [
      {
        id: 'action-1',
        tool_name: 'analysis.long',
        duration: 'long-running',
        pool: 'cpu_slow',
        state: 'running',
        cancelable: true,
        can_cancel: true,
        requested_at: new Date(NOW - 10_000).toISOString(),
        completed_at: null,
        error_code: null,
        agent_identity: { id: 'agent-1', label: 'Research CLI', kind: 'cli' },
      },
    ],
    jobCount: 1,
    activeCount: 1,
    terminalCount: 0,
    historyComplete: true,
    loading: false,
    error: null,
    observedAtMs: NOW - 250,
    ...overrides,
  };
}

describe('projectAgentJobsSnapshot', () => {
  it('keeps cached owner capability and counts while requiring a current post-ack collection', () => {
    const projected = projectAgentJobsSnapshot(source({ collectionStale: true }), { nowMs: NOW });
    expect(projected.collectionObservation).toMatchObject({
      state: 'unavailable',
      canReconnect: true,
    });
    expect(projected.jobs[0].observation.freshness).toBe('stale');
    expect(projected.jobs[0].canStop).toBe(true);
    expect(canRequestJobStop(projected.jobs[0])).toBe(false);
    expect(projected.historySummary).toMatchObject({ activeCount: 1, terminalCount: 0 });
  });
  it('preserves action ownership and exposes only live owner-advertised cancellation', () => {
    const projected = projectAgentJobsSnapshot(source(), { nowMs: NOW });

    expect(projected.jobs).toEqual([
      expect.objectContaining({
        id: 'agent-action:action-1',
        owner: { kind: 'agent-action', nativeId: 'action-1' },
        title: 'analysis.long',
        state: 'running',
        actorLabel: 'Research CLI',
        executionContext: expect.objectContaining({
          mode: 'managed',
          ownerLabel: 'Agent job',
          ownerInstanceId: 'agent-1',
        }),
        canStop: true,
        canOpenResult: false,
        canReleaseResult: false,
        canLoadActions: false,
      }),
    ]);
  });

  it('retains rows as stale and removes Stop when collection refresh fails', () => {
    const projected = projectAgentJobsSnapshot(
      source({ error: 'Agent job collection is unavailable' }),
      { nowMs: NOW }
    );

    expect(projected.collectionObservation).toMatchObject({
      state: 'unavailable',
      reason: 'Agent job collection is unavailable',
    });
    expect(projected.jobs[0]).toMatchObject({
      observation: {
        freshness: 'stale',
        reason: 'Agent job collection is unavailable',
      },
      canStop: false,
    });
  });
});
