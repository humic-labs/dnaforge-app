/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const importCompletedJob = vi.hoisted(() => vi.fn(async () => true));
const listJobs = vi.hoisted(() => vi.fn());
const recoverLegacyResult = vi.hoisted(() => vi.fn());
const reconcileWorkspaceAfterFilesChanged = vi.hoisted(() => vi.fn(async () => {}));
const bumpFileTreeRefresh = vi.hoisted(() => vi.fn());
const folders = vi.hoisted(() => [{ path: '/ws/lab', name: 'lab', addedAt: 1 }]);

vi.mock('./predict-structure', () => ({ importCompletedJob }));
vi.mock('../../services/workspace-operations', () => ({ reconcileWorkspaceAfterFilesChanged }));
vi.mock('../../platform', () => ({
  platform: () => ({
    compute: {
      recoverLegacyResult,
      listJobs,
      listJobsSnapshot: async ({ historyLimit }: { historyLimit: number }) => {
        const jobs = await listJobs({ limit: historyLimit });
        const activeCount = jobs.filter((row: { state: string }) =>
          ['intent', 'submitted', 'queued', 'running'].includes(row.state)
        ).length;
        return {
          jobs,
          jobCount: jobs.length,
          activeCount,
          terminalCount: jobs.length - activeCount,
          activeComplete: true,
          historyComplete: true,
          historyLimit,
        };
      },
    },
  }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: { folders: typeof folders }) => unknown) => selector({ folders }),
    { getState: () => ({ bumpFileTreeRefresh }) }
  ),
}));

import { ComputeJobsPanel } from './ComputeJobsPanel';
import { useComputeJobsStore } from './jobs-store';

afterEach(cleanup);

function job(patch: Record<string, unknown>) {
  return {
    id: 'row-1',
    provider: 'boltz',
    toolId: 'boltz-2',
    label: 'Ubiquitin · Boltz-2',
    remoteId: 'sab_1',
    state: 'completed',
    providerState: 'succeeded',
    settingsHash: 'h',
    importedPaths: [],
    lastError: null,
    pollCount: 1,
    nextPollAt: null,
    createdAt: '2026-09-11T00:00:00Z',
    updatedAt: '2026-09-11T00:00:00Z',
    costEstimate: 0.025,
    costEstimateUnit: 'USD',
    costActual: null,
    costActualUnit: null,
    workspaceRoot: '/ws/lab',
    ...patch,
  };
}

describe('ComputeJobsPanel', () => {
  it('recovers an imported job through the platform and reports success after Files reconciles', async () => {
    useComputeJobsStore.getState().resetForTests();
    listJobs.mockResolvedValue([
      job({ state: 'imported', importedPaths: ['/ws/lab/compute/boltz/sab_1/x.cif'] }),
    ]);
    recoverLegacyResult.mockResolvedValue({ targetRelativePath: 'Recovered compute 123456abcdef' });
    render(<ComputeJobsPanel />);
    fireEvent.click(await screen.findByTestId('compute-job-recover'));
    await waitFor(() => expect(recoverLegacyResult).toHaveBeenCalledWith('row-1'));
    await screen.findByText(
      'Recovered results are available in Files. The original files have been retained.'
    );
    expect(reconcileWorkspaceAfterFilesChanged).toHaveBeenCalledWith({
      workspaceRoot: '/ws/lab',
      revealPath: '/ws/lab/Recovered compute 123456abcdef',
      strict: true,
    });
    expect(bumpFileTreeRefresh).toHaveBeenCalled();
  });
  it('projects a smaller Settings view without narrowing the shared collection read', async () => {
    useComputeJobsStore.getState().resetForTests();
    listJobs.mockResolvedValue([
      job({ id: 'visible', state: 'running' }),
      job({ id: 'retained', state: 'running' }),
    ]);
    render(<ComputeJobsPanel limit={1} />);
    await screen.findByTestId('compute-job-visible');
    expect(screen.queryByTestId('compute-job-retained')).not.toBeInTheDocument();
    expect(useComputeJobsStore.getState().jobs).toHaveLength(2);
    expect(listJobs).toHaveBeenLastCalledWith({ limit: 200 });
  });
  it('imports a completed job into the workspace from the list', async () => {
    listJobs.mockResolvedValue([job({})]);
    render(<ComputeJobsPanel />);
    fireEvent.click(await screen.findByTestId('compute-job-import'));
    await waitFor(() =>
      expect(importCompletedJob).toHaveBeenCalledWith(
        expect.objectContaining({ remoteId: 'sab_1' }),
        folders
      )
    );
  });

  it('offers no import for jobs that are still running or already imported', async () => {
    listJobs.mockResolvedValue([
      job({ id: 'a', state: 'running' }),
      job({ id: 'b', state: 'imported', importedPaths: ['/ws/lab/compute/boltz/sab_1/x.cif'] }),
    ]);
    render(<ComputeJobsPanel />);
    await screen.findByTestId('compute-job-a');
    expect(screen.queryByTestId('compute-job-import')).toBeNull();
  });
});
