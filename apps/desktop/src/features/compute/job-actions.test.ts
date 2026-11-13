import { describe, expect, it, vi } from 'vitest';

import type { ComputeJobRecord } from '../../shared/compute-jobs-ipc';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import {
  cancelHostedComputeJob,
  importHostedComputeJob,
  openHostedComputeResult,
  type HostedComputeJobActionDeps,
} from './job-actions';

const folders: WorkspaceFolder[] = [{ path: '/ws/lab', name: 'lab', addedAt: 1 }];

function job(patch: Partial<ComputeJobRecord> = {}): ComputeJobRecord {
  return {
    id: 'local-job-1',
    provider: 'tamarind',
    toolId: 'esmfold',
    label: 'Hosted structure prediction',
    settingsHash: 'settings-hash',
    settings: {},
    remoteId: 'provider-job-42',
    state: 'running',
    providerState: 'Running',
    costEstimate: null,
    costEstimateUnit: null,
    costActual: null,
    costActualUnit: null,
    workspaceRoot: '/ws/lab',
    importedPaths: [],
    lastError: null,
    pollCount: 1,
    nextPollAt: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:01:00.000Z',
    ...patch,
  };
}

function deps(patch: Partial<HostedComputeJobActionDeps> = {}): HostedComputeJobActionDeps {
  return {
    newActionId: () => 'action-1',
    cancel: vi.fn(async () => ({
      ok: true,
      state: 'canceled',
      provider_state: 'Stopped',
    })),
    markCanceled: vi.fn(async (id, providerState) => job({ id, state: 'canceled', providerState })),
    importCompleted: vi.fn(async () => true),
    openDocument: vi.fn(async () => ({
      status: 'presented' as const,
      tabId: 'structure-1',
      panelId: 'panel-1',
      tabType: 'structure' as const,
      disposition: 'created' as const,
      content: 'loading' as const,
    })),
    ...patch,
  };
}

describe('hosted compute job actions', () => {
  it('reopens an inspection-owned result through its original mutation view instead of a detached file tab', async () => {
    const reopenInspection = vi.fn(async () => ({
      status: 'presented' as const,
      tabId: 'inspection',
      panelId: 'protein',
      tabType: 'structure' as const,
      disposition: 'reused' as const,
      content: 'loading' as const,
    }));
    const d = { ...deps(), reopenInspection };
    const completed = job({
      state: 'imported',
      importedPaths: ['/ws/lab/compute/model.pdb'],
      resultTarget: {
        kind: 'protein-inspection',
        documentId: 'ref',
        proteinKey: 'revision',
        proteinSequenceSha256: 'a'.repeat(64),
      },
    });
    await expect(openHostedComputeResult(completed, folders, d)).resolves.toMatchObject({
      tabId: 'inspection',
    });
    expect(reopenInspection).toHaveBeenCalledWith(completed);
    expect(d.openDocument).not.toHaveBeenCalled();
  });

  it('cancels through the compute owner and persists only a provider-confirmed cancellation', async () => {
    const d = deps();
    const updated = await cancelHostedComputeJob(job(), d);

    expect(d.cancel).toHaveBeenCalledWith(
      { provider: 'tamarind', remote_id: 'provider-job-42', tool_id: 'esmfold' },
      {
        grantedCapabilities: ['external-compute:manage'],
        initiator: 'user',
        toolCallId: 'ui-compute-cancel-action-1',
      }
    );
    expect(d.markCanceled).toHaveBeenCalledWith('local-job-1', 'Stopped');
    expect(updated).toMatchObject({ state: 'canceled', providerState: 'Stopped' });
  });

  it('does not mutate the registry when the provider refuses cancellation', async () => {
    const markCanceled = vi.fn();
    const d = deps({
      cancel: vi.fn(async () => ({
        ok: false,
        message: 'Provider cannot cancel this job.',
      })),
      markCanceled,
    });

    await expect(cancelHostedComputeJob(job(), d)).rejects.toThrow(
      'Provider cannot cancel this job.'
    );
    expect(markCanceled).not.toHaveBeenCalled();
  });

  it('does not mutate the registry when the provider returns a non-canceled state', async () => {
    const markCanceled = vi.fn();
    const d = deps({
      cancel: vi.fn(async () => ({
        ok: true,
        state: 'running',
        provider_state: 'Cancellation pending',
      })),
      markCanceled,
    });

    await expect(cancelHostedComputeJob(job(), d)).rejects.toThrow(
      'The provider reported running, not canceled.'
    );
    expect(markCanceled).not.toHaveBeenCalled();
  });

  it("imports only while the job's recorded workspace is mounted", async () => {
    const importCompleted = vi.fn(async () => true);
    const d = deps({ importCompleted });

    await expect(
      importHostedComputeJob(
        job({ state: 'completed' }),
        [{ path: '/ws/other', name: 'other', addedAt: 2 }],
        d
      )
    ).rejects.toThrow(/recorded workspace.*not open/i);
    expect(importCompleted).not.toHaveBeenCalled();

    await expect(importHostedComputeJob(job({ state: 'completed' }), folders, d)).resolves.toBe(
      true
    );
    expect(importCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-job-1', workspaceRoot: '/ws/lab' }),
      folders
    );
  });

  it('reopens the structure before auxiliary files and refuses sidecar or out-of-workspace paths', async () => {
    const openDocument = vi.fn(async () => ({
      status: 'presented' as const,
      tabId: 'structure-1',
      panelId: 'panel-1',
      tabType: 'structure' as const,
      disposition: 'created' as const,
      content: 'loading' as const,
    }));
    const d = deps({ openDocument });
    const imported = job({
      state: 'imported',
      importedPaths: [
        '/ws/lab/compute/tamarind/provider-job-42/compute-job.json',
        '/outside/result.pdb',
        '/ws/lab/compute/tamarind/provider-job-42/input.fasta',
        '/ws/lab/compute/tamarind/provider-job-42/run.log',
        '/ws/lab/compute/tamarind/provider-job-42/model.pdb',
      ],
    });

    await expect(openHostedComputeResult(imported, folders, d)).resolves.toMatchObject({
      status: 'presented',
    });
    expect(openDocument).toHaveBeenCalledOnce();
    expect(openDocument).toHaveBeenCalledWith({
      target: {
        kind: 'file',
        path: '/ws/lab/compute/tamarind/provider-job-42/model.pdb',
      },
      label: 'Hosted structure prediction',
      placement: { kind: 'smart' },
    });
  });

  it('opens the saved molecular view of a prediction instead of a catalog copy', async () => {
    const openDocument = vi.fn(async () => ({
      status: 'presented' as const,
      tabId: 'structure-1',
      panelId: 'panel-1',
      tabType: 'structure' as const,
      disposition: 'created' as const,
      content: 'loading' as const,
    }));
    const openCatalogResult = vi.fn(async () => null);
    const d = deps({ openDocument, openCatalogResult });
    const imported = job({
      state: 'imported',
      importedPaths: [
        '/ws/lab/proteins/designs.fasta',
        '/ws/lab/proteins/GFP prediction.dnaforge-molecular.json',
      ],
    });

    await expect(openHostedComputeResult(imported, folders, d)).resolves.toMatchObject({
      status: 'presented',
    });
    expect(openCatalogResult).not.toHaveBeenCalled();
    expect(openDocument).toHaveBeenCalledExactlyOnceWith({
      target: { kind: 'file', path: '/ws/lab/proteins/GFP prediction.dnaforge-molecular.json' },
      label: 'Hosted structure prediction',
      placement: { kind: 'smart' },
    });
  });

  it('refuses to import or open from an incompatible state or without a usable imported file', async () => {
    const d = deps();

    await expect(importHostedComputeJob(job({ state: 'running' }), folders, d)).rejects.toThrow(
      'Only a completed hosted job can be imported.'
    );
    await expect(
      openHostedComputeResult(
        job({
          state: 'imported',
          importedPaths: [
            '/ws/lab/compute/tamarind/provider-job-42/compute-job.json',
            '/outside/model.pdb',
          ],
        }),
        folders,
        d
      )
    ).rejects.toThrow('No imported file has a supported application view.');
    expect(d.importCompleted).not.toHaveBeenCalled();
    expect(d.openDocument).not.toHaveBeenCalled();
  });
});

describe('Jobs management helper outcomes', () => {
  it('returns false from the real import helper without manufacturing an imported record', async () => {
    const completed = job({ state: 'completed' });
    const importCompleted = vi.fn(async () => false);
    const d = deps({ importCompleted });
    await expect(importHostedComputeJob(completed, folders, d)).resolves.toBe(false);
    expect(importCompleted).toHaveBeenCalledExactlyOnceWith(completed, folders);
    expect(completed.state).toBe('completed');
    expect(completed.importedPaths).toEqual([]);
  });

  it('refuses provider cancellation when the native registry returns null', async () => {
    const d = deps({ markCanceled: vi.fn(async () => null) });
    await expect(cancelHostedComputeJob(job(), d)).rejects.toThrow(
      'The provider canceled this job, but DNAForge could not update its job record.'
    );
    expect(d.cancel).toHaveBeenCalledOnce();
    expect(d.markCanceled).toHaveBeenCalledExactlyOnceWith('local-job-1', 'Stopped');
  });

  it('treats a null catalog lookup as a fallback, then opens the exact retained structure', async () => {
    const imported = job({ state: 'imported', importedPaths: ['/ws/lab/compute/model.pdb'] });
    const openCatalogResult = vi.fn(async () => null);
    const d = deps({ openCatalogResult });
    await expect(openHostedComputeResult(imported, folders, d)).resolves.toMatchObject({
      status: 'presented',
      content: 'loading',
    });
    expect(openCatalogResult).toHaveBeenCalledExactlyOnceWith(imported);
    expect(d.openDocument).toHaveBeenCalledExactlyOnceWith({
      target: { kind: 'file', path: '/ws/lab/compute/model.pdb' },
      label: 'Hosted structure prediction',
      placement: { kind: 'smart' },
    });
  });

  it('refuses a null catalog lookup when no legitimate retained artifact remains', async () => {
    const imported = job({
      state: 'imported',
      importedPaths: ['/outside/model.pdb', '/ws/lab/compute/compute-job.json'],
    });
    const d = deps({ openCatalogResult: vi.fn(async () => null) });
    await expect(openHostedComputeResult(imported, folders, d)).rejects.toThrow(
      'No imported file has a supported application view.'
    );
    expect(d.openDocument).not.toHaveBeenCalled();
  });

  it('preserves an actual document refusal as an error, never a presented result', async () => {
    const d = deps({
      openCatalogResult: vi.fn(async () => null),
      openDocument: vi.fn(async () => ({
        status: 'blocked' as const,
        message: 'PRIVATE retained target unavailable',
      })),
    });
    await expect(
      openHostedComputeResult(
        job({ state: 'imported', importedPaths: ['/ws/lab/model.pdb'] }),
        folders,
        d
      )
    ).rejects.toThrow('PRIVATE retained target unavailable');
    expect(d.openDocument).toHaveBeenCalledOnce();
  });
});
