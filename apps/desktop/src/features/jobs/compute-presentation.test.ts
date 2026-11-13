// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { ComputeJobRecord } from '../../shared/compute-jobs-ipc';
import { projectComputeJobsSnapshot } from './compute-presentation';
import { canRequestJobStop } from './presentation';

const NOW = Date.UTC(2026, 8, 15, 22, 0, 0);

function computeJob(overrides: Partial<ComputeJobRecord> = {}): ComputeJobRecord {
  return {
    id: 'local-compute-1',
    provider: 'tamarind',
    toolId: 'esmfold',
    label: 'Hosted structure prediction',
    settingsHash: 'settings-sha256',
    settings: { model: 'esmfold' },
    remoteId: 'provider-job-42',
    state: 'running',
    providerState: 'RUNNING',
    costEstimate: 0.25,
    costEstimateUnit: 'weighted_hours',
    costActual: null,
    costActualUnit: null,
    workspaceRoot: '/workspace/example',
    importedPaths: [],
    lastError: null,
    pollCount: 2,
    nextPollAt: new Date(NOW + 5_000).toISOString(),
    createdAt: new Date(NOW - 90_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  };
}

describe('projectComputeJobsSnapshot', () => {
  it('projects native totals beyond its page and preserves an old active row with supported current Stop', () => {
    const projected = projectComputeJobsSnapshot(
      {
        jobs: [
          computeJob({ id: 'new-terminal', state: 'completed' }),
          computeJob({ id: 'old-active' }),
        ],
        loading: false,
        error: null,
        observedAtMs: NOW,
        coverage: {
          jobCount: 206,
          activeCount: 1,
          terminalCount: 205,
          activeComplete: true,
          historyComplete: false,
          historyLimit: 200,
        },
      },
      {
        nowMs: NOW,
        historyLimit: 200,
        cancellationByProvider: { tamarind: { mode: 'provider', note: 'Supported' } },
      }
    );
    expect(projected.historySummary).toEqual({
      operationCount: 206,
      activeCount: 1,
      terminalCount: 205,
      historyComplete: false,
    });
    expect(projected.collectionObservation.state).toBe('current');
    expect(
      canRequestJobStop(projected.jobs.find((row) => row.owner.nativeId === 'old-active')!)
    ).toBe(true);
  });

  it('refuses a global completeness claim from an unqualified scoped array', () => {
    const projected = projectComputeJobsSnapshot(
      { jobs: [computeJob()], loading: false, error: null, observedAtMs: NOW },
      { nowMs: NOW, historyLimit: 200 }
    );
    expect(projected.historySummary).toBeUndefined();
    expect(projected.collectionObservation).toMatchObject({
      state: 'unavailable',
      canReconnect: true,
    });
    expect(projected.jobs[0].observation.freshness).toBe('stale');
  });

  it('distinguishes a native empty receipt from a never-read collection and a failed cached receipt', () => {
    const coverage = {
      jobCount: 0,
      activeCount: 0,
      terminalCount: 0,
      activeComplete: true as const,
      historyComplete: true,
      historyLimit: 200,
    };
    const source = { jobs: [], loading: false, error: null, observedAtMs: NOW, coverage };
    expect(projectComputeJobsSnapshot(source, { nowMs: NOW, historyLimit: 200 })).toMatchObject({
      collectionObservation: { state: 'current' },
      historySummary: {
        operationCount: 0,
        activeCount: 0,
        terminalCount: 0,
        historyComplete: true,
      },
    });
    expect(
      projectComputeJobsSnapshot(
        { ...source, coverage: null, observedAtMs: null },
        { nowMs: NOW, historyLimit: 200 }
      ).collectionObservation.state
    ).toBe('connecting');
    expect(
      projectComputeJobsSnapshot(
        { ...source, error: 'Registry unavailable', collectionStale: true },
        { nowMs: NOW, historyLimit: 200 }
      )
    ).toMatchObject({
      collectionObservation: { state: 'unavailable' },
      historySummary: { operationCount: 0, historyComplete: true },
    });
  });

  it('does not turn a write or partial-read receipt into current collection or Stop authority', () => {
    const projected = projectComputeJobsSnapshot(
      {
        jobs: [computeJob()],
        loading: false,
        error: null,
        observedAtMs: NOW,
        collectionStale: true,
      },
      {
        nowMs: NOW,
        historyLimit: 200,
        cancellationByProvider: { tamarind: { mode: 'provider', note: 'Supported' } },
      }
    );
    expect(projected.collectionObservation).toMatchObject({
      state: 'unavailable',
      canReconnect: true,
    });
    expect(projected.jobs[0].observation).toMatchObject({ freshness: 'stale', observedAtMs: NOW });
    expect(projected.jobs[0].canStop).toBe(true);
    expect(canRequestJobStop(projected.jobs[0])).toBe(false);
  });
  it('preserves hosted-compute identity and advertises no control the owner lacks', () => {
    const projected = projectComputeJobsSnapshot(
      {
        jobs: [computeJob()],
        loading: false,
        error: null,
        observedAtMs: NOW - 500,
        coverage: {
          jobCount: 1,
          activeCount: 1,
          terminalCount: 0,
          activeComplete: true,
          historyComplete: true,
          historyLimit: 200,
        },
      },
      { nowMs: NOW, historyLimit: 200 }
    );

    expect(projected.collectionObservation).toEqual({
      state: 'current',
      observedAtMs: NOW - 500,
    });
    expect(projected.jobs).toEqual([
      expect.objectContaining({
        id: 'compute:local-compute-1',
        owner: { kind: 'hosted-compute', nativeId: 'local-compute-1' },
        title: 'Hosted structure prediction',
        state: 'running',
        observation: { freshness: 'current', observedAtMs: NOW - 500 },
        executionContext: expect.objectContaining({
          mode: 'connected',
          ownerLabel: 'tamarind',
          ownerInstanceId: 'provider-job-42',
        }),
        canStop: false,
        canOpenResult: false,
        canReleaseResult: false,
        canLoadActions: false,
      }),
    ]);
    expect(projected.jobs[0]?.stopUnavailableReason).toMatch(/does not advertise cancellation/i);
  });

  it('advertises only owner-backed actions for active, completed, and imported jobs', () => {
    const projected = projectComputeJobsSnapshot(
      {
        jobs: [
          computeJob(),
          computeJob({ id: 'completed', state: 'completed' }),
          computeJob({
            id: 'imported',
            state: 'imported',
            importedPaths: [
              '/workspace/example/compute/tamarind/provider-job-42/model.pdb',
              '/workspace/example/compute/tamarind/provider-job-42/compute-job.json',
            ],
          }),
          computeJob({ id: 'uncancelable', provider: 'boltz' }),
          computeJob({
            id: 'unsafe-imported',
            state: 'imported',
            importedPaths: ['/outside/model.pdb'],
          }),
        ],
        loading: false,
        error: null,
        observedAtMs: NOW,
        coverage: {
          jobCount: 5,
          activeCount: 2,
          terminalCount: 3,
          activeComplete: true,
          historyComplete: true,
          historyLimit: 200,
        },
      },
      {
        nowMs: NOW,
        historyLimit: 200,
        cancellationByProvider: {
          tamarind: { mode: 'provider', note: 'Tamarind can cancel queued or running jobs.' },
          boltz: { mode: 'unavailable', note: 'Boltz cannot cancel after submission.' },
        },
      }
    );

    expect(projected.jobs[0]).toMatchObject({
      canStop: true,
      canImportResult: false,
      canOpenResult: false,
    });
    expect(projected.jobs[1]).toMatchObject({
      canStop: false,
      canImportResult: true,
      canOpenResult: false,
    });
    expect(projected.jobs[2]).toMatchObject({
      canStop: false,
      canImportResult: false,
      canOpenResult: true,
    });
    expect(projected.jobs[3]).toMatchObject({
      canStop: false,
      stopUnavailableReason: 'Boltz cannot cancel after submission.',
    });
    expect(projected.jobs[4]).toMatchObject({ canOpenResult: false });
  });

  it('keeps retained records but marks their observation stale after refresh failure', () => {
    const projected = projectComputeJobsSnapshot(
      {
        jobs: [computeJob({ state: 'submitted', providerState: 'QUEUED' })],
        loading: false,
        error: 'Main-process compute registry is unavailable',
        observedAtMs: NOW - 30_000,
      },
      { nowMs: NOW, historyLimit: 200 }
    );

    expect(projected.collectionObservation).toMatchObject({
      state: 'unavailable',
      observedAtMs: NOW - 30_000,
      reason: 'Main-process compute registry is unavailable',
    });
    expect(projected.jobs[0]).toMatchObject({
      state: 'queued',
      observation: {
        freshness: 'stale',
        observedAtMs: NOW - 30_000,
        reason: 'Main-process compute registry is unavailable',
      },
    });
  });

  it('distinguishes provider completion from workspace import', () => {
    const projected = projectComputeJobsSnapshot(
      {
        jobs: [
          computeJob({ state: 'completed', providerState: 'SUCCEEDED' }),
          computeJob({
            id: 'legacy-rootless',
            state: 'completed',
            providerState: 'SUCCEEDED',
            workspaceRoot: null,
          }),
          computeJob({
            id: 'local-compute-2',
            state: 'imported',
            providerState: 'SUCCEEDED',
            importedPaths: ['/workspace/example/compute/result.pdb'],
          }),
        ],
        loading: false,
        error: null,
        observedAtMs: NOW,
        coverage: {
          jobCount: 3,
          activeCount: 0,
          terminalCount: 3,
          activeComplete: true,
          historyComplete: true,
          historyLimit: 200,
        },
      },
      { nowMs: NOW, historyLimit: 200 }
    );

    expect(projected.jobs[0]).toMatchObject({
      state: 'succeeded',
      result: {
        availability: 'available',
        reason: expect.stringMatching(/import from Jobs/i),
      },
    });
    expect(projected.jobs[1]).toMatchObject({
      canImportResult: false,
      result: {
        availability: 'available',
        reason: expect.stringMatching(/no recorded workspace.*Settings/i),
      },
    });
    expect(projected.jobs[2]).toMatchObject({
      state: 'succeeded',
      result: {
        availability: 'available',
        reason: expect.stringMatching(/imported into the workspace/i),
      },
      resultSummary: expect.stringMatching(/1 file/i),
    });
  });
});
