import {
  persistHostedWorkspaceSelection,
  withHostedWorkspaceSelection,
} from './workspace-selection';
import {
  WorkspaceSessionController,
  type WorkspaceSessionAdapter,
} from '@waypoint/domain-services';
import {
  createHostedWorkspaceRuntime,
  DEFAULT_DEPENDENCIES,
  type HostedWorkspaceRuntimeDependencies,
} from './runtime';
import { createDurableHostedRuntime } from './sync-runtime';
import { HostedWorkspaceApiError, prepareHostedWorkspaceWrites } from './api';

let demoDependencies: HostedWorkspaceRuntimeDependencies | null = null;

export function setBrowserDemoWorkspaceStorage(
  dependencies: HostedWorkspaceRuntimeDependencies | null
): void {
  demoDependencies = dependencies;
}

const activeDependencies = () => demoDependencies ?? DEFAULT_DEPENDENCIES;

const routedDependencies: HostedWorkspaceRuntimeDependencies = {
  loadIndex: (...args) => activeDependencies().loadIndex(...args),
  createWorkspace: (...args) => activeDependencies().createWorkspace(...args),
  loadManifest: (...args) => activeDependencies().loadManifest(...args),
  loadHistory: (...args) => activeDependencies().loadHistory(...args),
  downloadFile: (...args) => activeDependencies().downloadFile(...args),
  publishFiles: (...args) => activeDependencies().publishFiles(...args),
  restoreVersion: (...args) => activeDependencies().restoreVersion(...args),
  retainCandidate: (...args) => {
    if (demoDependencies || !DEFAULT_DEPENDENCIES.retainCandidate) {
      return Promise.reject(
        new HostedWorkspaceApiError(503, 'UNAVAILABLE', 'Recovery copies need an account.')
      );
    }
    return DEFAULT_DEPENDENCIES.retainCandidate(...args);
  },
};

let canApplyRemote = () => true;
const routedRuntime = createHostedWorkspaceRuntime(routedDependencies);
const routedAuthority: WorkspaceSessionAdapter = {
  ...routedRuntime,
  get retainRecoveryCandidate() {
    return demoDependencies ? undefined : routedRuntime.retainRecoveryCandidate;
  },
};

export const hostedDurableSync = createDurableHostedRuntime(routedAuthority, {
  canApplyRemote: () => canApplyRemote(),
  prepareWrites: async ({ workspaceId, snapshot, writes, removePaths, expectedAccountId }) => {
    if (demoDependencies) return;
    await prepareHostedWorkspaceWrites({
      workspaceId,
      files: writes,
      removePaths,
      expectedAccountId,
      baseFiles: snapshot.files.map((file) => {
        if (!file.contentSha256) throw new Error('Saved input is missing its immutable digest.');
        return {
          ...file,
          resourceId: file.resourceId ?? undefined,
          contentSha256: file.contentSha256,
        };
      }),
    });
  },
});
export const hostedWorkspaceSessionController = new WorkspaceSessionController(
  withHostedWorkspaceSelection(hostedDurableSync.runtime)
);
persistHostedWorkspaceSelection(hostedWorkspaceSessionController);

let refreshing: Promise<void> | null = null;
let refreshRequested = false;
hostedDurableSync.subscribe(() => {
  if (!hostedWorkspaceSessionController.getState().snapshot) return;
  refreshRequested = true;
  if (refreshing) return;
  refreshing = (async () => {
    while (refreshRequested) {
      refreshRequested = false;
      try {
        await hostedWorkspaceSessionController.refreshActiveWorkspace();
      } catch {}
    }
  })().finally(() => {
    refreshing = null;
  });
});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void hostedDurableSync.flushAll();
  });
}

export function startHostedBackgroundSync(safeToRefresh: () => boolean): () => void {
  canApplyRemote = safeToRefresh;
  let running = false;
  const refresh = async () => {
    if (running || document.hidden || !safeToRefresh()) return;
    const state = hostedWorkspaceSessionController.getState();
    if (!state.snapshot || !['idle', 'error'].includes(state.phase)) return;
    running = true;
    try {
      await hostedDurableSync.flushAll();
      if (safeToRefresh()) await hostedWorkspaceSessionController.refreshActiveWorkspace();
    } catch {
    } finally {
      running = false;
    }
  };
  const wake = () => {
    void refresh();
  };
  const timer = setInterval(wake, 10_000);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', wake);
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}

let hostedInitialization: Promise<void> | null = null;

export function initializeHostedWorkspaceSession(
  preferredWorkspaceId?: string | null
): Promise<void> {
  if (hostedInitialization) return hostedInitialization;
  const pending = hostedWorkspaceSessionController.initialize(preferredWorkspaceId);
  const tracked = pending.finally(() => {
    if (hostedInitialization === tracked) hostedInitialization = null;
  });
  hostedInitialization = tracked;
  return tracked;
}
