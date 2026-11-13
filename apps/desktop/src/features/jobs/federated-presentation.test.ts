// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { JobsSidebarSnapshot } from './presentation';
import { combineJobsSnapshots } from './federated-presentation';
import { projectComputeJobsSnapshot } from './compute-presentation';
import { projectJobsSnapshot } from './presentation';
import type { ComputeJobRecord } from '../../shared/compute-jobs-ipc';

const NOW = Date.UTC(2026, 8, 15, 22, 0, 0);

function computeJob(overrides: Partial<ComputeJobRecord> = {}): ComputeJobRecord {
  return {
    id: 'old-compute',
    provider: 'synthetic',
    toolId: 'fold',
    label: null,
    settingsHash: 'fixture',
    settings: {},
    remoteId: 'synthetic-remote',
    state: 'running',
    providerState: 'running',
    costEstimate: null,
    costEstimateUnit: null,
    costActual: null,
    costActualUnit: null,
    workspaceRoot: null,
    importedPaths: [],
    lastError: null,
    pollCount: 0,
    nextPollAt: null,
    createdAt: new Date(NOW - 1000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function source(
  label: string,
  id: string,
  owner: JobsSidebarSnapshot['jobs'][number]['owner'],
  state: JobsSidebarSnapshot['jobs'][number]['state'] = 'running'
) {
  return {
    label,
    snapshot: {
      nowMs: NOW,
      collectionObservation: { state: 'current' as const, observedAtMs: NOW },
      jobs: [
        {
          id,
          owner,
          title: label,
          actorLabel: 'DNAForge',
          state,
          observation: { freshness: 'current' as const, observedAtMs: NOW },
          result: { availability: 'none' as const },
          review: { state: 'not-required' as const },
          executionContext: { mode: 'managed' as const },
          createdAtMs: NOW - 1_000,
          canStop: false,
          canLoadActions: false,
        },
      ],
    },
  };
}

describe('combineJobsSnapshots', () => {
  it.each([
    { managed: 0, agent: 0 },
    { managed: 1, agent: 0 },
    { managed: 3, agent: 2 },
  ])('retains compute history independently of terminal owner coverage %j', (counts) => {
    const terminalCompute = Array.from({ length: 200 }, (_, index) =>
      computeJob({ id: `terminal-${205 - index}`, state: 'completed' })
    );
    const otherSources = (['managed', 'agent'] as const).map((kind) => {
      const ownerKind = kind === 'managed' ? 'managed-operation' : 'agent-action';
      const prefix = kind === 'managed' ? 'operation' : 'agent-action';
      const jobs = Array.from(
        { length: counts[kind] },
        (_, index) =>
          source(
            kind,
            `${prefix}:${index}`,
            { kind: ownerKind, nativeId: String(index) },
            'succeeded'
          ).snapshot.jobs[0]!
      );
      return {
        label: kind,
        snapshot: {
          nowMs: NOW,
          collectionObservation: { state: 'current' as const, observedAtMs: NOW },
          jobs,
          historySummary: {
            operationCount: jobs.length,
            activeCount: 0,
            terminalCount: jobs.length,
            historyComplete: true,
          },
        },
      };
    });
    for (const activeCount of [1, 0]) {
      const compute = projectComputeJobsSnapshot(
        {
          jobs: [...terminalCompute, ...(activeCount ? [computeJob()] : [])],
          loading: false,
          error: null,
          observedAtMs: NOW,
          coverage: {
            jobCount: 206,
            activeCount,
            terminalCount: 206 - activeCount,
            activeComplete: true,
            historyComplete: false,
            historyLimit: 200,
          },
        },
        { nowMs: NOW, historyLimit: 200 }
      );
      const combined = combineJobsSnapshots(
        [{ label: 'Compute', snapshot: compute }, ...otherSources],
        { nowMs: NOW }
      );
      expect(
        combined.jobs
          .filter((job) => job.owner.kind === 'hosted-compute')
          .map((job) => job.owner.nativeId)
      ).toEqual([...terminalCompute.map((job) => job.id), ...(activeCount ? ['old-compute'] : [])]);
      expect(
        combined.jobs.filter((job) => job.owner.kind !== 'hosted-compute').map((job) => job.id)
      ).toEqual(otherSources.flatMap(({ snapshot }) => snapshot.jobs.map((job) => job.id)));
      expect(projectJobsSnapshot(combined).historyCoverage).toEqual({
        operationCount: 206 + counts.managed + counts.agent,
        activeCount,
        terminalCount: 206 - activeCount + counts.managed + counts.agent,
        visibleTerminalCount: 200 + counts.managed + counts.agent,
        historyComplete: false,
      });
      expect(projectJobsSnapshot(combined).activeCount).toBe(activeCount);
    }
  });

  it('combines exact compute totals with other owner coverage while retaining stale and current row authority', () => {
    const computeRow = computeJob();
    const computeSource = {
      jobs: [computeRow],
      loading: false,
      error: null,
      observedAtMs: NOW,
      coverage: {
        jobCount: 206,
        activeCount: 1,
        terminalCount: 205,
        activeComplete: true as const,
        historyComplete: false,
        historyLimit: 200,
      },
    };
    const managed: JobsSidebarSnapshot = {
      ...source('Managed', 'operation:one', { kind: 'managed-operation', nativeId: 'one' })
        .snapshot,
      historySummary: {
        operationCount: 2,
        activeCount: 1,
        terminalCount: 1,
        historyComplete: true,
      },
    };
    const agent: JobsSidebarSnapshot = {
      ...source('Agent', 'agent-action:one', { kind: 'agent-action', nativeId: 'one' }).snapshot,
      historySummary: {
        operationCount: 1,
        activeCount: 1,
        terminalCount: 0,
        historyComplete: true,
      },
    };
    const combine = (stale: boolean) =>
      combineJobsSnapshots(
        [
          { label: 'Managed', snapshot: managed },
          { label: 'Agent', snapshot: agent },
          {
            label: 'Compute',
            snapshot: projectComputeJobsSnapshot(
              { ...computeSource, collectionStale: stale },
              { nowMs: NOW, historyLimit: 200 }
            ),
          },
        ],
        { nowMs: NOW }
      );
    const current = combine(false);
    expect(current.historySummary).toEqual({
      operationCount: 209,
      activeCount: 3,
      terminalCount: 206,
      historyComplete: false,
    });
    expect(projectJobsSnapshot(current).activeCount).toBe(3);
    const stale = combine(true);
    expect(stale.collectionObservation.state).toBe('unavailable');
    expect(projectJobsSnapshot(stale)).toMatchObject({ activeCount: 2, uncertainCount: 1 });
    expect(
      stale.jobs.find((row) => row.owner.kind === 'managed-operation')?.observation.freshness
    ).toBe('current');
  });
  it('keeps colliding owner-native IDs distinct through namespaced summary identities', () => {
    const combined = combineJobsSnapshots(
      [
        source('Managed operation', 'operation:shared-id', {
          kind: 'managed-operation',
          nativeId: 'shared-id',
        }),
        source('Hosted compute', 'compute:shared-id', {
          kind: 'hosted-compute',
          nativeId: 'shared-id',
        }),
      ],
      { nowMs: NOW }
    );

    expect(combined.jobs.map((job) => job.id)).toEqual([
      'operation:shared-id',
      'compute:shared-id',
    ]);
    expect(new Set(combined.jobs.map((job) => job.id)).size).toBe(2);
  });

  it('reports partial owner failure without discarding current rows from another owner', () => {
    const managed = source('Managed operation', 'operation:managed-1', {
      kind: 'managed-operation',
      nativeId: 'managed-1',
    });
    const compute = source('Hosted compute', 'compute:compute-1', {
      kind: 'hosted-compute',
      nativeId: 'compute-1',
    });
    compute.snapshot.collectionObservation = {
      state: 'unavailable',
      observedAtMs: NOW - 30_000,
      reason: 'Compute registry could not be read',
    };
    compute.snapshot.jobs[0] = {
      ...compute.snapshot.jobs[0],
      observation: {
        freshness: 'stale',
        observedAtMs: NOW - 30_000,
        reason: 'Compute registry could not be read',
      },
    };

    const combined = combineJobsSnapshots([managed, compute], { nowMs: NOW });

    expect(combined.collectionObservation).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/Hosted compute: Compute registry could not be read/),
    });
    expect(combined.jobs).toHaveLength(2);
    expect(combined.jobs[0]?.observation.freshness).toBe('current');
    expect(combined.jobs[1]?.observation.freshness).toBe('stale');
  });
});
