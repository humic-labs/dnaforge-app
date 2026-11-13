import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ initPlatform: vi.fn() }));
vi.mock('../agent-bridge/public/install-renderer-agent-bridge', () => ({
  installRendererAgentBridge: vi.fn(() => vi.fn()),
}));
vi.mock('./molecular-experiment-viewer', () => ({ createMolecularExperimentViewer: vi.fn() }));

import { createMolecularExperimentWorkerRuntime } from './molecular-experiment-worker';
import { createMolecularExperimentViewer } from './molecular-experiment-viewer';
import type { ProteinExperimentWorkerWorkspace } from '../../shared/protein-experiment-workers';

describe('native experiment worker lifecycle', () => {
  it('prepares up to four pinned views and releases their exact ownership', async () => {
    const dispose = vi.fn();
    vi.mocked(createMolecularExperimentViewer).mockImplementation(async (fixture) => ({
      structureViewId: fixture.structureViewId,
      viewerId: fixture.structureViewId,
      cacheKey: fixture.structureViewId,
      dispose,
      assertFreshStart: vi.fn().mockResolvedValue(undefined),
    }));
    const runtime = createMolecularExperimentWorkerRuntime();
    await runtime.handle({
      kind: 'prepare',
      requestId: 'prepare-four',
      request: {
        jobId: 'four',
        label: 'Four pinned sources',
        fixtures: Array.from({ length: 4 }, (_, i) => ({
          structureViewId: `source-${i}`,
          attrs: {},
        })),
        workspace: { folders: [], activeWorkspaceFile: null },
      },
    });
    expect(runtime.summary().viewers).toHaveLength(4);
    await runtime.handle({ kind: 'release', requestId: 'release-four', jobId: 'four' });
    expect(dispose).toHaveBeenCalledTimes(4);
    expect(runtime.summary().viewers).toHaveLength(0);
  });
  it('reports a retired runtime as disposed and refuses a new preparation', async () => {
    const runtime = createMolecularExperimentWorkerRuntime();
    expect(runtime.summary()).toMatchObject({ disposed: false, jobs: 0, preparing: 0 });
    runtime.dispose();
    expect(runtime.summary()).toMatchObject({ disposed: true, jobs: 0, preparing: 0 });
    await expect(
      runtime.handle({
        requestId: 'retired',
        kind: 'prepare',
        request: {
          jobId: 'new',
          label: 'Must refuse',
          fixtures: [],
          workspace: { folders: [], activeWorkspaceFile: null },
        },
      })
    ).rejects.toThrow(/closed/);
  });
  it('renews actor bindings only when a released worker changes workspace scope', async () => {
    vi.mocked(createMolecularExperimentViewer).mockImplementation(async (fixture) => ({
      structureViewId: fixture.structureViewId,
      viewerId: fixture.structureViewId,
      cacheKey: fixture.structureViewId,
      dispose: vi.fn(),
      assertFreshStart: vi.fn().mockResolvedValue(undefined),
    }));
    const renewBindings = vi.fn();
    const runtime = createMolecularExperimentWorkerRuntime(renewBindings);
    const populated: ProteinExperimentWorkerWorkspace = {
      folders: [{ path: '/owned-workspace', name: 'Owned workspace', addedAt: 1 }],
      activeWorkspaceFile: null,
    };
    const empty: ProteinExperimentWorkerWorkspace = { folders: [], activeWorkspaceFile: null };
    const prepare = (jobId: string, workspace: ProteinExperimentWorkerWorkspace) =>
      runtime.handle({
        kind: 'prepare',
        requestId: `prepare-${jobId}`,
        request: {
          jobId,
          label: 'Owned scope reuse',
          fixtures: [{ structureViewId: `view-${jobId}`, attrs: {} }],
          workspace,
        },
      });
    await prepare('first', populated);
    await prepare('concurrent', populated);
    await expect(prepare('wrong-scope', empty)).rejects.toThrow(/workspace scope unchanged/);
    expect(renewBindings).not.toHaveBeenCalled();
    await runtime.handle({ kind: 'release', requestId: 'release-first', jobId: 'first' });
    await expect(prepare('still-owned', empty)).rejects.toThrow(/workspace scope unchanged/);
    await runtime.handle({ kind: 'release', requestId: 'release-concurrent', jobId: 'concurrent' });
    await prepare('reused', empty);
    expect(renewBindings).toHaveBeenCalledTimes(1);
    await runtime.handle({ kind: 'release', requestId: 'release-reused', jobId: 'reused' });
    await prepare('same-scope', empty);
    expect(renewBindings).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
});
