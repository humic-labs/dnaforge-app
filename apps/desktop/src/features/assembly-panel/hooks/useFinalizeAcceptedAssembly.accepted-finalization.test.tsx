// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore } from '../../design/public/store';
import type { SequenceDesign } from '../../design/public/types';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { realAssemblyPipelineAppScenario } from '../../../test/scenarios/assembly-real-pipeline';
import { useFinalizeAcceptedAssembly } from './useFinalizeAcceptedAssembly';

const mocks = vi.hoisted(() => ({
  error: null as Error | null,
  trackError: vi.fn(),
  exists: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../lib/analytics', () => ({
  trackToolActionStarted: vi.fn(),
  trackToolActionCompleted: vi.fn(),
  trackToolOperationError: mocks.trackError,
}));
vi.mock('../../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: () => ({ complete: vi.fn(), fail: vi.fn(), cancel: vi.fn() }),
  abandonOpenWorkflowActions: vi.fn(),
}));
vi.mock('../../assembly/public/issues/assembly-issues', () => ({
  deriveAssemblyIssues: () => [],
  issueBlocksGate: () => false,
}));
vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { exists: mocks.exists } }),
}));
vi.mock('../../assembly/public/accepted-finalization-preview', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../assembly/public/accepted-finalization-preview')>();
  return {
    ...original,
    resolveBoundAcceptedPackageForDesign: async () => null,
    prepareFinalizationCandidate: (input: Parameters<typeof original.prepareFinalizationCandidate>[0]) => {
      if (mocks.error) throw mocks.error;
      return original.prepareFinalizationCandidate(input);
    },
  };
});

function readyDesign(): SequenceDesign {
  const scenario = realAssemblyPipelineAppScenario('gibson-pcr-pcr');
  const design = Object.values(scenario.designs!.designs!)[0];
  return { ...design, assemblyState: 'ready', version: 10 };
}

async function exportDesign(design: SequenceDesign) {
  const hook = renderHook(() => useFinalizeAcceptedAssembly(design));
  await waitFor(() => expect(hook.result.current.destinationState).toBe('unbound'));
  expect(hook.result.current.canFinalize).toBe(true);
  await act(async () => { await hook.result.current.finalize(); });
  return hook;
}

describe(' export failure contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.error = null;
    useWorkspaceStore.setState({ folders: [{ name: 'workspace', path: '/workspace', addedAt: 1 }] });
  });

  it('reports a real stale design guard as validation with a one-click draft remedy before filesystem access', async () => {
    const design = readyDesign();
    useDesignStore.setState({ designs: { [design.id]: { ...design, version: 11 } } });
    const hook = await exportDesign(design);
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.trackError).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'assembly', attemptedAction: 'exported', errorClass: 'validation', reasonCode: 'stale_design',
    }));
    expect(hook.result.current.status).toMatchObject({ state: 'error', recovery: 'draft' });
    expect(String('message' in hook.result.current.status && hook.result.current.status.message)).not.toContain('get_design');
    expect(hook.result.current).toHaveProperty('redraft', expect.any(Function));
  });

  it.each(['EACCES', 'ENOENT', 'EEXIST', 'ENOSPC'])('classifies real %s errors as filesystem without exporting private details', async (code) => {
    mocks.error = Object.assign(new Error(`${code}: /Users/private/project.gb`), { code });
    await exportDesign(readyDesign());
    expect(mocks.trackError).toHaveBeenCalledWith(expect.objectContaining({
      errorClass: 'filesystem', reasonCode: 'filesystem_error',
    }));
    expect(JSON.stringify(mocks.trackError.mock.calls)).not.toContain('/Users/private');
  });

  it('does not classify an untyped precondition refusal as a filesystem error', async () => {
    mocks.error = new Error('Finalization output must be inside an open writable project.');
    await exportDesign(readyDesign());
    expect(mocks.trackError).toHaveBeenCalledWith(expect.objectContaining({
      errorClass: 'validation', reasonCode: 'precondition_failed',
    }));
  });
});
