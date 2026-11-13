import { describe, expect, it, vi } from 'vitest';

import { handleComputeJobTerminal } from './job-terminal-adapter';
import type { ComputeJobTerminalEvent } from '../../shared/compute-jobs-ipc';

const event = (over: Partial<ComputeJobTerminalEvent> = {}): ComputeJobTerminalEvent => ({
  id: 'row-1',
  provider: 'tamarind',
  toolId: 'esmfold',
  remoteId: 'ubiquitin-ESMFold',
  label: 'ubiquitin · ESMFold',
  state: 'completed',
  workspaceRoot: '/ws',
  importedPaths: [],
  lastError: null,
  ...over,
});

function deps() {
  return {
    refreshJobs: vi.fn(),
    notify: vi.fn(),
    importJob: vi.fn(async () => undefined),
  };
}

describe('compute job terminal adapter', () => {
  it('offers an import for a completed job, naming it, and refreshes the panel', () => {
    const d = deps();
    handleComputeJobTerminal(event(), d);

    expect(d.refreshJobs).toHaveBeenCalledTimes(1);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toMatchObject({ provider: 'tamarind', state: 'completed' });
  });

  it('imports only when the user takes the offer, then refreshes again', async () => {
    const d = deps();
    handleComputeJobTerminal(event(), d);
    expect(d.importJob).not.toHaveBeenCalled();

    const onImport = d.notify.mock.calls[0][1] as () => void;
    onImport();
    await vi.waitFor(() => expect(d.importJob).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(d.refreshJobs).toHaveBeenCalledTimes(2));
  });

  it('stays quiet when the provider never gave the job an id, since import would refuse', () => {
    const d = deps();
    handleComputeJobTerminal(event({ remoteId: null }), d);
    expect(d.refreshJobs).toHaveBeenCalledTimes(1);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('never offers an import for a job that failed, was canceled, or already imported', () => {
    for (const state of ['failed', 'canceled', 'imported'] as const) {
      const d = deps();
      handleComputeJobTerminal(event({ state }), d);
      expect(d.refreshJobs, state).toHaveBeenCalledTimes(1);
      expect(d.notify, state).not.toHaveBeenCalled();
    }
  });
});
