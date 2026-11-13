import type {
  ProteinExperimentWorkersApi,
  ProteinExperimentWorkerRequest,
} from '../../shared/protein-experiment-workers';
import { MAX_PROTEIN_EXPERIMENT_FIXTURES } from '../../shared/protein-experiment-workers';
import { initPlatform } from '../../platform';
import { useWorkspaceStore, workspaceScopeFromState } from '../../stores/workspaceStore';
import { installRendererAgentBridge } from '../agent-bridge/public/install-renderer-agent-bridge';
import { molecularRenderProfileSelectionSchema } from '../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import {
  createMolecularExperimentViewer,
  type MolecularExperimentViewer,
} from './molecular-experiment-viewer';

export function createMolecularExperimentWorkerRuntime(onIdleWorkspaceScopeChange?: () => void) {
  const jobs = new Map<string, MolecularExperimentViewer[]>();
  const preparing = new Set<string>();
  let workspaceScope: string | null | undefined;
  let disposed = false;
  const release = (jobId: string) => {
    for (const viewer of jobs.get(jobId) ?? []) viewer.dispose();
    jobs.delete(jobId);
  };
  return {
    async handle(request: ProteinExperimentWorkerRequest): Promise<void> {
      if (disposed) throw new Error('The experiment renderer has closed.');
      if (request.kind === 'release') {
        if (preparing.has(request.jobId))
          throw new Error('The experiment is still preparing its scene.');
        release(request.jobId);
        return;
      }
      if (request.kind === 'assert-fresh-start') {
        const viewers = jobs.get(request.jobId);
        if (!viewers || preparing.has(request.jobId))
          throw new Error('The fresh experiment is not ready.');
        await Promise.all(viewers.map((viewer) => viewer.assertFreshStart()));
        return;
      }
      const input = request.request;
      if (jobs.has(input.jobId) || preparing.has(input.jobId))
        throw new Error('This experiment job already owns a scene.');
      if (
        input.fixtures.length < 1 ||
        input.fixtures.length > MAX_PROTEIN_EXPERIMENT_FIXTURES ||
        new Set(input.fixtures.map((f) => f.structureViewId)).size !== input.fixtures.length
      )
        throw new Error('An experiment requires one to four distinct pinned views.');
      const nextScope = workspaceScopeFromState(input.workspace);
      if ((jobs.size > 0 || preparing.size > 0) && workspaceScope !== nextScope)
        throw new Error('Concurrent experiments must keep their workspace scope unchanged.');
      if (workspaceScope !== undefined && workspaceScope !== nextScope)
        onIdleWorkspaceScopeChange?.();
      workspaceScope = nextScope;
      useWorkspaceStore.setState({
        folders: input.workspace.folders.map((folder) => ({ ...folder })),
        activeWorkspaceFile: input.workspace.activeWorkspaceFile,
      });
      const profile = molecularRenderProfileSelectionSchema.parse(input.renderProfile ?? 'default');
      preparing.add(input.jobId);
      try {
        const outcomes = await Promise.allSettled(
          input.fixtures.map((fixture) =>
            createMolecularExperimentViewer(
              fixture,
              input.label,
              profile,
              input.purpose ?? 'fresh-author'
            )
          )
        );
        const viewers = outcomes.flatMap((outcome) =>
          outcome.status === 'fulfilled' ? [outcome.value] : []
        );
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (disposed || failure?.status === 'rejected') {
          for (const viewer of viewers) viewer.dispose();
          throw failure?.status === 'rejected'
            ? failure.reason
            : new Error('The experiment renderer has closed.');
        }
        jobs.set(input.jobId, viewers);
      } finally {
        preparing.delete(input.jobId);
      }
    },
    dispose() {
      disposed = true;
      for (const jobId of jobs.keys()) release(jobId);
    },
    summary() {
      return {
        disposed,
        jobs: jobs.size,
        preparing: preparing.size,
        viewers: [...jobs.values()].flat().map((viewer) => ({
          structureViewId: viewer.structureViewId,
          viewerId: viewer.viewerId,
          cacheKey: viewer.cacheKey,
        })),
      };
    },
  };
}

export async function bootMolecularExperimentWorker(): Promise<() => void> {
  const api = (
    window as Window & {
      electronAPI?: {
        proteinExperimentWorkers?: ProteinExperimentWorkersApi;
      };
    }
  ).electronAPI?.proteinExperimentWorkers;
  if (!api) throw new Error('The background experiment preload bridge is unavailable.');
  await initPlatform();
  let uninstallBridge = installRendererAgentBridge();
  const runtime = createMolecularExperimentWorkerRuntime(() => {
    uninstallBridge();
    uninstallBridge = installRendererAgentBridge();
  });
  const unsubscribe = api.onRequest((request) => {
    void runtime.handle(request).then(
      () => api.respond({ requestId: request.requestId, ok: true }),
      (error) =>
        api.respond({
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
    );
  });
  const dispose = () => {
    unsubscribe();
    uninstallBridge();
    runtime.dispose();
  };
  window.addEventListener('pagehide', dispose, { once: true });
  if (import.meta.hot) {
    import.meta.hot.accept();
    import.meta.hot.dispose(() => {
      dispose();
      window.close();
    });
  }
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    (
      window as Window & { __proteinWorkerSummary?: () => ReturnType<typeof runtime.summary> }
    ).__proteinWorkerSummary = runtime.summary;
  }
  try {
    await api.ready();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
